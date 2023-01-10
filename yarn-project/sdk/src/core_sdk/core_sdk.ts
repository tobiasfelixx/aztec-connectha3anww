import { AliasHash } from '@aztec/barretenberg/account_id';
import { EthAddress, GrumpkinAddress } from '@aztec/barretenberg/address';
import { toBigIntBE } from '@aztec/barretenberg/bigint_buffer';
import { BridgeCallData } from '@aztec/barretenberg/bridge_call_data';
import { AccountProver, JoinSplitProver, ProofData, ProofId, UnrolledProver } from '@aztec/barretenberg/client_proofs';
import { NetCrs } from '@aztec/barretenberg/crs';
import { keccak256, Blake2s, Pedersen, randomBytes, Schnorr } from '@aztec/barretenberg/crypto';
import { Grumpkin } from '@aztec/barretenberg/ecc';
import { InitHelpers } from '@aztec/barretenberg/environment';
import { FftFactory } from '@aztec/barretenberg/fft';
import { createDebugLogger } from '@aztec/barretenberg/log';
import { NoteAlgorithms, NoteDecryptor } from '@aztec/barretenberg/note_algorithms';
import { OffchainAccountData } from '@aztec/barretenberg/offchain_tx_data';
import { Pippenger } from '@aztec/barretenberg/pippenger';
import { retryUntil } from '@aztec/barretenberg/retry';
import { RollupProofData } from '@aztec/barretenberg/rollup_proof';
import { BridgePublishQuery, BridgePublishQueryResult, RollupProvider, Tx } from '@aztec/barretenberg/rollup_provider';
import { InterruptableSleep } from '@aztec/barretenberg/sleep';
import { Timer } from '@aztec/barretenberg/timer';
import { TxId } from '@aztec/barretenberg/tx_id';
import { BarretenbergWasm, WorkerPool } from '@aztec/barretenberg/wasm';
import { WorldState, WorldStateConstants } from '@aztec/barretenberg/world_state';
import { EventEmitter } from 'events';
import { LevelUp } from 'levelup';
import { BlockContext } from '../block_context/block_context.js';
import { CorePaymentTx, createCorePaymentTxForRecipient } from '../core_tx/index.js';
import { Alias, Database } from '../database/index.js';
import { parseGenesisAliasesAndKeys, getUserSpendingKeysFromGenesisData } from '../genesis_state/index.js';
import { Note, treeNoteToNote } from '../note/index.js';
import {
  AccountProofCreator,
  AccountProofInput,
  DefiDepositProofCreator,
  JoinSplitProofInput,
  PaymentProofCreator,
  ProofOutput,
} from '../proofs/index.js';
import { MutexSerialQueue, SerialQueue } from '../serial_queue/index.js';
import { SchnorrSigner } from '../signer/index.js';
import { UserState, UserStateEvent, UserStateFactory } from '../user_state/index.js';
import { CoreSdkInterface } from './core_sdk_interface.js';
import { CoreSdkOptions } from './core_sdk_options.js';
import { SdkEvent, SdkStatus } from './sdk_status.js';
import { sdkVersion } from './sdk_version.js';
import { UserData } from '../user/index.js';
import isNode from 'detect-node';

enum SdkInitState {
  // Constructed but uninitialized. Unusable.
  UNINITIALIZED = 'UNINITIALIZED',
  // Initialized but not yet synching data tree and user accounts. Can be queried for data, but not create proofs.
  INITIALIZED = 'INITIALIZED',
  // Synchronises data tree and user accounts. Ready for proof construction.
  RUNNING = 'RUNNING',
  // Stop requested. Wait for synching task to return.
  STOPPING = 'STOPPING',
  // Unusable.
  DESTROYED = 'DESTROYED',
}

/**
 * CoreSdk is responsible for keeping everything in sync and proof construction.
 * init() should be called before making any other calls to construct the basic components.
 * run() should be called once a client wants to start synching, or requesting proof construction.
 * Takes ownership of injected components (should destroy them etc).
 * A serial queue ensures that all calls that modify internal state happen in sequence.
 * By default, the serial queue is protected with a cross-process mutex, ensuring that if multiple instances
 * of the CoreSdk exist in different processes, that they will not modify state at the same time.
 */
export class CoreSdk extends EventEmitter implements CoreSdkInterface {
  private dataVersion = 1;
  private options!: CoreSdkOptions;
  private worldState!: WorldState;
  private userStates: UserState[] = [];
  private joinSplitProver!: JoinSplitProver;
  private accountProver!: AccountProver;
  private paymentProofCreator!: PaymentProofCreator;
  private accountProofCreator!: AccountProofCreator;
  private defiDepositProofCreator!: DefiDepositProofCreator;
  private serialQueue!: SerialQueue;
  private statelessSerialQueue!: SerialQueue;
  private broadcastChannel: BroadcastChannel | undefined = isNode ? undefined : new BroadcastChannel('aztec-sdk');
  private userStateFactory!: UserStateFactory;
  private sdkStatus: SdkStatus = {
    serverUrl: '',
    chainId: -1,
    rollupContractAddress: EthAddress.ZERO,
    permitHelperContractAddress: EthAddress.ZERO,
    verifierContractAddress: EthAddress.ZERO,
    feePayingAssetIds: [0],
    rollupSize: -1,
    syncedToRollup: -1,
    latestRollupId: -1,
    dataRoot: Buffer.alloc(0),
    dataSize: 0,
    useKeyCache: false,
    proverless: false,
    version: sdkVersion,
  };
  private initState = SdkInitState.UNINITIALIZED;
  private noteAlgos!: NoteAlgorithms;
  private blake2s!: Blake2s;
  private grumpkin!: Grumpkin;
  private schnorr!: Schnorr;
  private syncSleep = new InterruptableSleep();
  private synchingPromise!: Promise<void>;
  private treeSyncCount = 0;
  private debug = createDebugLogger('bb:core_sdk');

  constructor(
    private leveldb: LevelUp,
    private db: Database,
    private rollupProvider: RollupProvider,
    private barretenberg: BarretenbergWasm,
    private noteDecryptor: NoteDecryptor,
    private pedersen: Pedersen,
    private pippenger: Pippenger,
    private fftFactory: FftFactory,
    private workerPool?: WorkerPool,
  ) {
    super();

    if (this.broadcastChannel) {
      this.broadcastChannel.onmessage = ({ data: { event, args } }) => {
        if (event === SdkEvent.UPDATED_USER_STATE) {
          this.emit(SdkEvent.UPDATED_USER_STATE, GrumpkinAddress.fromString(args[0]));
        }
      };
    }
    this.rollupProvider.on('versionMismatch', error => {
      this.debug(error);
      this.emit(SdkEvent.VERSION_MISMATCH);
    });
  }

  /**
   * Constructs internal components.
   * Erases dbs if rollup contract address changed.
   * Loads and initializes known user accounts.
   * Destroys injected components on failure.
   */
  public async init(options: CoreSdkOptions) {
    if (this.initState !== SdkInitState.UNINITIALIZED) {
      throw new Error('Already initialized.');
    }

    try {
      this.debug(`initializing...${sdkVersion ? ` (version: ${sdkVersion})` : ''}`);

      this.options = options;
      // Tasks in serialQueue require states like notes and hash path, which will need the sdk to sync to (ideally)
      // the latest block. Tasks in statelessSerialQueue don't.
      this.serialQueue = new MutexSerialQueue(this.db, 'aztec_core_sdk');
      this.statelessSerialQueue = new MutexSerialQueue(this.db, 'aztec_core_sdk_stateless');
      this.noteAlgos = new NoteAlgorithms(this.barretenberg);
      this.blake2s = new Blake2s(this.barretenberg);
      this.grumpkin = new Grumpkin(this.barretenberg);
      this.schnorr = new Schnorr(this.barretenberg);
      this.userStateFactory = new UserStateFactory(
        this.grumpkin,
        this.noteAlgos,
        this.noteDecryptor,
        this.db,
        this.rollupProvider,
      );
      this.worldState = new WorldState(this.leveldb, this.pedersen);

      const {
        blockchainStatus: { chainId, rollupContractAddress, permitHelperContractAddress, verifierContractAddress },
        runtimeConfig: { feePayingAssetIds, useKeyCache },
        rollupSize,
        proverless,
      } = await this.getRemoteStatus();

      // Clear all data if contract changed or dataVersion changed.
      const rca = await this.getLocalRollupContractAddress();
      const localDataVersion = await this.getLocalDataVersion();
      if ((rca && !rca.equals(rollupContractAddress)) || localDataVersion !== this.dataVersion) {
        this.debug('erasing database...');
        await this.leveldb.clear();
        await this.db.clear();
        await this.setLocalDataVersion(this.dataVersion);
      }

      await this.db.addKey('rollupContractAddress', rollupContractAddress.toBuffer());

      // Initialize the "mutable" merkle tree. This is the tree that represents all layers about each rollup subtree.
      const subtreeDepth = Math.ceil(Math.log2(rollupSize * WorldStateConstants.NUM_NEW_DATA_TREE_NOTES_PER_TX));
      await this.worldState.init(subtreeDepth);

      this.sdkStatus = {
        ...this.sdkStatus,
        serverUrl: options.serverUrl,
        chainId,
        rollupContractAddress,
        permitHelperContractAddress,
        verifierContractAddress,
        feePayingAssetIds,
        rollupSize,
        syncedToRollup: await this.getLocalSyncedToRollup(),
        latestRollupId: await this.rollupProvider.getLatestRollupId(),
        dataSize: this.worldState.getSize(),
        dataRoot: this.worldState.getRoot(),
        useKeyCache,
        proverless,
      };

      // Ensures we can get the list of users and access current known balances.
      await this.initUserStates();

      this.initState = SdkInitState.INITIALIZED;
      this.debug('initialization complete.');
    } catch (err) {
      this.debug('initialization failed: ', err);
      // If initialization fails, we should destroy the components we've taken ownership of.
      await this.leveldb.close();
      await this.db.close();
      await this.workerPool?.destroy();
      this.serialQueue?.cancel();
      this.statelessSerialQueue?.cancel();
      throw err;
    }
  }

  public async destroy() {
    this.debug('destroying...');

    // If sync() task is running, signals it to stop, to awake for exit if it's asleep, and awaits the exit.
    this.initState = SdkInitState.STOPPING;
    this.syncSleep.interrupt();
    await this.synchingPromise;

    // The serial queue will cancel itself. This ensures that anything currently in the queue finishes, and ensures
    // that once the await to push() returns, nothing else is on, or can be added to the queue.
    await this.serialQueue.push(() => Promise.resolve(this.serialQueue.cancel()));
    await this.statelessSerialQueue.push(() => Promise.resolve(this.statelessSerialQueue.cancel()));

    // Stop listening to account state updates.
    this.userStates.forEach(us => us.removeAllListeners());

    // Destroy injected components.
    await this.fftFactory.destroy();
    await this.leveldb.close();
    await this.db.close();
    await this.workerPool?.destroy();

    // Destroy components.
    this.broadcastChannel?.close();

    this.initState = SdkInitState.DESTROYED;
    this.emit(SdkEvent.DESTROYED);
    this.removeAllListeners();

    this.debug('destroyed.');
  }

  public getLocalStatus() {
    return Promise.resolve({ ...this.sdkStatus });
  }

  public async getRemoteStatus() {
    return await this.rollupProvider.getStatus();
  }

  public async isAccountRegistered(accountPublicKey: GrumpkinAddress, includePending: boolean) {
    return (
      !!(await this.db.getAlias(accountPublicKey)) ||
      (includePending && (await this.rollupProvider.isAccountRegistered(accountPublicKey)))
    );
  }

  public async isAliasRegistered(alias: string, includePending: boolean) {
    const aliasHash = this.computeAliasHash(alias);
    return (
      (await this.db.getAliases(aliasHash)).length > 0 ||
      (includePending && (await this.rollupProvider.isAliasRegistered(alias)))
    );
  }

  public async isAliasRegisteredToAccount(accountPublicKey: GrumpkinAddress, alias: string, includePending: boolean) {
    const aliasHash = this.computeAliasHash(alias);
    const savedAlias = await this.db.getAlias(accountPublicKey);
    return savedAlias
      ? savedAlias.aliasHash.equals(aliasHash)
      : includePending && (await this.rollupProvider.isAliasRegisteredToAccount(accountPublicKey, alias));
  }

  public async getAccountPublicKey(alias: string) {
    const aliasHash = this.computeAliasHash(alias);
    const aliases = await this.db.getAliases(aliasHash);
    return aliases[0]?.accountPublicKey;
  }

  public async getTxFees(assetId: number) {
    return await this.rollupProvider.getTxFees(assetId);
  }

  public async getDefiFees(bridgeCallData: BridgeCallData) {
    return await this.rollupProvider.getDefiFees(bridgeCallData);
  }

  public async getPendingDepositTxs() {
    return await this.rollupProvider.getPendingDepositTxs();
  }

  public async getDefiInteractionNonce(txId: TxId) {
    const tx = await this.db.getDefiTx(txId);
    if (!tx) {
      throw new Error('Unknown txId');
    }
    return tx.interactionNonce;
  }

  public async userExists(userId: GrumpkinAddress) {
    return !!(await this.db.getUser(userId));
  }

  public getUsers() {
    return Promise.resolve(this.userStates.map(us => us.getUserData().accountPublicKey));
  }

  public derivePublicKey(privateKey: Buffer) {
    return Promise.resolve(new GrumpkinAddress(this.grumpkin.mul(Grumpkin.generator, privateKey)));
  }

  public deriveLegacySigningMessageHash(address: EthAddress) {
    const signingMessage = this.blake2s.hashToField(address.toBuffer());
    return Promise.resolve(keccak256(signingMessage));
  }

  public constructSignature(message: Buffer, privateKey: Buffer) {
    return Promise.resolve(this.schnorr.constructSignature(message, privateKey));
  }

  public async addUser(accountPrivateKey: Buffer, noSync = false) {
    return await this.serialQueue.push(async () => {
      const accountPublicKey = await this.derivePublicKey(accountPrivateKey);
      if (await this.db.getUser(accountPublicKey)) {
        throw new Error(`User already exists: ${accountPublicKey}`);
      }

      const { latestRollupId } = this.sdkStatus;
      const syncedToRollup = noSync ? latestRollupId : -1;
      const user: UserData = { accountPrivateKey, accountPublicKey, syncedToRollup };
      await this.db.addUser(user);

      await this.addInitialUserSpendingKeys([user.accountPublicKey]);

      const userState = await this.userStateFactory.createUserState(user);
      userState.on(UserStateEvent.UPDATED_USER_STATE, id => {
        this.emit(SdkEvent.UPDATED_USER_STATE, id);
        this.broadcastChannel?.postMessage({
          event: SdkEvent.UPDATED_USER_STATE,
          args: [id.toString()],
        });
      });
      this.userStates.push(userState);

      if (!noSync) {
        // If the sync microtask is sleeping, wake it up to start syncing.
        this.syncSleep.interrupt();
      }

      return accountPublicKey;
    });
  }

  private async retrieveGenesisData() {
    const stored = await this.db.getGenesisData();
    if (stored.length) {
      return stored;
    }
    this.debug('genesis data not found locally, retrieving from server...');
    const serverData = await this.rollupProvider.getInitialWorldState();
    await this.db.setGenesisData(serverData.initialAccounts);
    return serverData.initialAccounts;
  }

  public async removeUser(userId: GrumpkinAddress) {
    return await this.serialQueue.push(async () => {
      const userState = this.getUserState(userId);
      this.userStates = this.userStates.filter(us => us !== userState);
      userState.removeAllListeners();
      await this.db.removeUser(userId);
    });
  }

  public getUserSyncedToRollup(userId: GrumpkinAddress) {
    return Promise.resolve(this.getUserState(userId).getUserData().syncedToRollup);
  }

  public async getSpendingKeys(userId: GrumpkinAddress) {
    const keys = await this.db.getSpendingKeys(userId);
    return keys.map(k => k.key);
  }

  public async getBalances(userId: GrumpkinAddress) {
    return await this.getUserState(userId).getBalances();
  }

  public async getBalance(userId: GrumpkinAddress, assetId: number) {
    const userState = this.getUserState(userId);
    return await userState.getBalance(assetId);
  }

  public async getSpendableNoteValues(
    userId: GrumpkinAddress,
    assetId: number,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
  ) {
    const userState = this.getUserState(userId);
    return await userState.getSpendableNoteValues(assetId, spendingKeyRequired, excludePendingNotes);
  }

  public async getSpendableSum(
    userId: GrumpkinAddress,
    assetId: number,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
  ) {
    const userState = this.getUserState(userId);
    return await userState.getSpendableSum(assetId, spendingKeyRequired, excludePendingNotes);
  }

  public async getSpendableSums(userId: GrumpkinAddress, spendingKeyRequired?: boolean, excludePendingNotes?: boolean) {
    const userState = this.getUserState(userId);
    return await userState.getSpendableSums(spendingKeyRequired, excludePendingNotes);
  }

  public async getMaxSpendableNoteValues(
    userId: GrumpkinAddress,
    assetId: number,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
    numNotes?: number,
  ) {
    const userState = this.getUserState(userId);
    return await userState.getMaxSpendableNoteValues(assetId, spendingKeyRequired, excludePendingNotes, numNotes);
  }

  public async pickNotes(
    userId: GrumpkinAddress,
    assetId: number,
    value: bigint,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
  ) {
    return await this.getUserState(userId).pickNotes(assetId, value, spendingKeyRequired, excludePendingNotes);
  }

  public async pickNote(
    userId: GrumpkinAddress,
    assetId: number,
    value: bigint,
    spendingKeyRequired?: boolean,
    excludePendingNotes?: boolean,
  ) {
    return await this.getUserState(userId).pickNote(assetId, value, spendingKeyRequired, excludePendingNotes);
  }

  public async getUserTxs(userId: GrumpkinAddress) {
    return await this.db.getUserTxs(userId);
  }

  /**
   * Moves the sdk into RUNNING state.
   * Kicks off data tree updates, user note decryptions, alias table updates, proving key construction.
   */
  public run() {
    if (this.initState === SdkInitState.RUNNING) {
      return Promise.resolve();
    }

    this.initState = SdkInitState.RUNNING;

    const initPippenngerPromise = this.statelessSerialQueue.push(async () => {
      const maxCircuitSize = Math.max(JoinSplitProver.getCircuitSize(), AccountProver.getCircuitSize());
      const crsData = await this.getCrsData(maxCircuitSize);
      await this.pippenger.init(crsData);
    });

    this.serialQueue
      .push(async () => {
        await initPippenngerPromise;

        await this.genesisSync();
        this.startReceivingBlocks();

        await this.statelessSerialQueue.push(async () => {
          const { proverless, verifierContractAddress } = this.sdkStatus;

          await this.createJoinSplitProofCreator(proverless);
          await this.createAccountProofCreator(proverless);

          if (this.userStates.length) {
            await this.computeJoinSplitProvingKey();
          } else {
            await this.computeAccountProvingKey();
          }

          // Makes the saved proving keys considered valid. Hence set this after they're saved.
          await this.db.addKey('verifierContractAddress', verifierContractAddress.toBuffer());
        });
      })
      .catch(err => {
        this.debug('failed to run:', err);
        return this.destroy();
      });

    return Promise.resolve();
  }

  // -------------------------------------------------------
  // PUBLIC METHODS FROM HERE ON REQUIRE run() TO BE CALLED.
  // -------------------------------------------------------

  public async createDepositProof(
    assetId: number,
    publicInput: bigint,
    privateOutput: bigint,
    depositor: EthAddress,
    recipient: GrumpkinAddress,
    recipientSpendingKeyRequired: boolean,
    txRefNo: number,
  ) {
    return await this.statelessSerialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);

      // Create a one time user to generate and sign the proof.
      const accountPrivateKey = randomBytes(32);
      const accountPublicKey = await this.derivePublicKey(accountPrivateKey);
      const user = {
        accountPrivateKey,
        accountPublicKey,
      } as UserData;
      const signer = new SchnorrSigner(this, accountPublicKey, accountPrivateKey);
      const spendingPublicKey = accountPublicKey;

      const { proverless } = this.sdkStatus;
      await this.createJoinSplitProofCreator(proverless);

      const proofInput = await this.paymentProofCreator.createProofInput(
        user,
        [], // notes
        BigInt(0), // privateInput
        privateOutput,
        BigInt(0), // senderPrivateOutput
        publicInput,
        BigInt(0), // publicOutput
        assetId,
        recipient,
        recipientSpendingKeyRequired,
        depositor,
        spendingPublicKey,
        0, // allowChain
      );
      const signature = await signer.signMessage(proofInput.signingData);

      await this.computeJoinSplitProvingKey();
      return this.paymentProofCreator.createProof(user, { ...proofInput, signature }, txRefNo);
    });
  }

  public async createPaymentProofInputs(
    userId: GrumpkinAddress,
    assetId: number,
    publicInput: bigint,
    publicOutput: bigint,
    privateInput: bigint,
    recipientPrivateOutput: bigint,
    senderPrivateOutput: bigint,
    noteRecipient: GrumpkinAddress | undefined,
    recipientSpendingKeyRequired: boolean,
    publicOwner: EthAddress | undefined,
    spendingPublicKey: GrumpkinAddress,
    allowChain: number,
  ) {
    return await this.serialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);

      const userState = this.getUserState(userId);
      const user = userState.getUserData();

      const spendingKeyRequired = !spendingPublicKey.equals(userId);
      const notes = privateInput ? await userState.pickNotes(assetId, privateInput, spendingKeyRequired) : [];
      if (privateInput && !notes.length) {
        throw new Error(`Failed to find notes that sum to ${privateInput}.`);
      }

      const proofInputs: JoinSplitProofInput[] = [];
      const settledNotes = notes.filter(n => !n.pending);
      let firstNote = notes.find(n => n.pending) || settledNotes.shift()!;
      const lastNote = settledNotes.pop();

      // Create chained txs to generate one large value note.
      for (const note of settledNotes) {
        const inputNotes = [firstNote, note];
        const noteSum = inputNotes.reduce((sum, n) => sum + n.value, BigInt(0));
        const proofInput = await this.paymentProofCreator.createProofInput(
          user,
          inputNotes,
          noteSum, // privateInput
          BigInt(0), // recipientPrivateOutput
          noteSum, // senderPrivateOutput
          BigInt(0), // publicInput,
          BigInt(0), // publicOutput
          assetId,
          userId, // noteRecipient
          spendingKeyRequired,
          undefined, // publicOwner
          spendingPublicKey,
          2,
        );
        proofInputs.push(proofInput);
        firstNote = treeNoteToNote(proofInput.tx.outputNotes[1], user.accountPrivateKey, this.noteAlgos, {
          allowChain: true,
        });
      }

      // Spend the last note and the large value note for whatever this payment proof is for.
      {
        const inputNotes = lastNote ? [firstNote, lastNote] : [firstNote];
        const proofInput = await this.paymentProofCreator.createProofInput(
          user,
          inputNotes,
          privateInput,
          recipientPrivateOutput,
          senderPrivateOutput,
          publicInput,
          publicOutput,
          assetId,
          noteRecipient,
          recipientSpendingKeyRequired,
          publicOwner,
          spendingPublicKey,
          allowChain,
        );
        proofInputs.push(proofInput);
      }

      return proofInputs;
    });
  }

  public async createPaymentProof(input: JoinSplitProofInput, txRefNo: number) {
    return await this.serialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);

      const { outputNotes } = input.tx;
      const userId = outputNotes[1].ownerPubKey;
      const userState = this.getUserState(userId);
      const user = userState.getUserData();

      await this.computeJoinSplitProvingKey();

      return await this.paymentProofCreator.createProof(user, input, txRefNo);
    });
  }

  public async createAccountProofSigningData(
    accountPublicKey: GrumpkinAddress,
    alias: string,
    migrate: boolean,
    spendingPublicKey: GrumpkinAddress,
    newAccountPublicKey?: GrumpkinAddress,
    newSpendingPublicKey1?: GrumpkinAddress,
    newSpendingPublicKey2?: GrumpkinAddress,
  ) {
    return await this.serialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);
      const aliasHash = this.computeAliasHash(alias);
      const { signingData } = await this.accountProofCreator.createProofInput(
        accountPublicKey,
        aliasHash,
        migrate,
        spendingPublicKey,
        newAccountPublicKey,
        newSpendingPublicKey1,
        newSpendingPublicKey2,
        false, // spendingKeyExists
      );
      return signingData;
    });
  }

  public async createAccountProofInput(
    userId: GrumpkinAddress,
    spendingPublicKey: GrumpkinAddress,
    migrate: boolean,
    newAlias: string | undefined,
    newSpendingPublicKey1?: GrumpkinAddress,
    newSpendingPublicKey2?: GrumpkinAddress,
    newAccountPrivateKey?: Buffer,
  ) {
    return await this.serialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);
      const aliasHash = newAlias ? this.computeAliasHash(newAlias) : (await this.db.getAlias(userId))?.aliasHash;
      if (!aliasHash) {
        throw new Error('Account not registered or not fully synced.');
      }
      const newAccountPublicKey = newAccountPrivateKey ? await this.derivePublicKey(newAccountPrivateKey) : undefined;
      return await this.accountProofCreator.createProofInput(
        userId,
        aliasHash,
        migrate,
        spendingPublicKey,
        newAccountPublicKey,
        newSpendingPublicKey1,
        newSpendingPublicKey2,
      );
    });
  }

  public async createAccountProof(input: AccountProofInput, txRefNo: number) {
    return await this.serialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);

      await this.computeAccountProvingKey();

      return await this.accountProofCreator.createProof(input, txRefNo);
    });
  }

  public async createDefiProofInput(
    userId: GrumpkinAddress,
    bridgeCallData: BridgeCallData,
    depositValue: bigint,
    inputNotes: Note[],
    spendingPublicKey: GrumpkinAddress,
  ) {
    return await this.serialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);
      const userState = this.getUserState(userId);
      const user = userState.getUserData();
      return await this.defiDepositProofCreator.createProofInput(
        user,
        bridgeCallData,
        depositValue,
        inputNotes,
        spendingPublicKey,
      );
    });
  }

  public async createDefiProof(input: JoinSplitProofInput, txRefNo: number) {
    return await this.serialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);

      const { outputNotes } = input.tx;
      const userId = outputNotes[1].ownerPubKey;
      const userState = this.getUserState(userId);
      const user = userState.getUserData();

      await this.computeJoinSplitProvingKey();

      return await this.defiDepositProofCreator.createProof(user, input, txRefNo);
    });
  }

  public async sendProofs(proofs: ProofOutput[], proofTxs: Tx[] = [], proofRequestData?: any) {
    return await this.serialQueue.push(async () => {
      this.assertInitState(SdkInitState.RUNNING);

      const txs = proofs.map(({ proofData, offchainTxData, signature }) => ({
        proofData: proofData.rawProofData,
        offchainTxData: offchainTxData.toBuffer(),
        depositSignature: signature,
      }));

      const txIds = await this.rollupProvider.sendTxs([...proofTxs, ...txs]).catch(async e => {
        if (e.message === 'Insufficient fee.') {
          await this.rollupProvider.clientLog({
            error: e.message,
            proofRequestData,
            proofs: proofs.map(p => ProofId[p.tx.proofId]),
            proofTxs: proofTxs.map(p => ProofId[ProofData.getProofIdFromBuffer(p.proofData)]),
            elapsed: Date.now() - (proofRequestData?.created || 0),
          });
        }
        throw e;
      });

      for (const proof of proofs) {
        const { userId } = proof.tx;
        try {
          await this.getUserState(userId).addProof(proof);
        } catch (e) {
          // Proof sender is not added.
        }

        // Add the payment proof to recipient's account if they are not the sender.
        if ([ProofId.DEPOSIT, ProofId.SEND].includes(proof.tx.proofId)) {
          const recipient = proof.outputNotes[0].owner;
          if (!recipient.equals(userId)) {
            const recipientTx = createCorePaymentTxForRecipient(proof.tx as CorePaymentTx, recipient);
            try {
              await this.getUserState(recipient).addProof({ ...proof, tx: recipientTx });
            } catch (e) {
              // Recipient's account is not added.
            }
          }
        }
      }

      return txIds;
    });
  }

  public async awaitSynchronised(timeout?: number) {
    this.assertInitState(SdkInitState.RUNNING);

    await retryUntil(() => this.isSynchronised(), 'data synchronised', timeout);
  }

  public isUserSynching(userId: GrumpkinAddress) {
    this.assertInitState(SdkInitState.RUNNING);

    return Promise.resolve(!this.getUserState(userId).isSynchronised(this.sdkStatus.latestRollupId));
  }

  public async awaitUserSynchronised(userId: GrumpkinAddress, timeout?: number) {
    this.assertInitState(SdkInitState.RUNNING);

    await this.getUserState(userId).awaitSynchronised(this.sdkStatus.latestRollupId, timeout);
  }

  public async awaitSettlement(txId: TxId, timeout?: number) {
    this.assertInitState(SdkInitState.RUNNING);

    await retryUntil(() => this.db.isUserTxSettled(txId), `tx settlement: ${txId}`, timeout);
  }

  public async awaitDefiDepositCompletion(txId: TxId, timeout?: number) {
    this.assertInitState(SdkInitState.RUNNING);

    const defiDepositCompleted = async () => {
      const tx = await this.db.getDefiTx(txId);
      if (!tx) {
        throw new Error('Unknown txId.');
      }

      return !!tx.settled;
    };
    await retryUntil(defiDepositCompleted, `defi interaction: ${txId}`, timeout);
  }

  public async awaitDefiFinalisation(txId: TxId, timeout?: number) {
    this.assertInitState(SdkInitState.RUNNING);

    const defiFinalised = async () => {
      const tx = await this.db.getDefiTx(txId);
      if (!tx) {
        throw new Error('Unknown txId.');
      }

      return !!tx.finalised;
    };
    await retryUntil(defiFinalised, `defi finalisation: ${txId}`, timeout);
  }

  public async awaitDefiSettlement(txId: TxId, timeout?: number) {
    this.assertInitState(SdkInitState.RUNNING);

    const defiSettled = async () => {
      const tx = await this.db.getDefiTx(txId);
      if (!tx) {
        throw new Error('Unknown txId.');
      }

      return !!tx.claimSettled;
    };
    await retryUntil(defiSettled, `defi settlement: ${txId}`, timeout);
  }

  // ---------------
  // PRIVATE METHODS
  // ---------------

  private getUserState(userId: GrumpkinAddress) {
    const userState = this.userStates.find(us => us.getUserData().accountPublicKey.equals(userId));
    if (!userState) {
      throw new Error(`User not found: ${userId}`);
    }
    return userState;
  }

  private isSynchronised() {
    return this.sdkStatus.syncedToRollup === this.sdkStatus.latestRollupId;
  }

  private assertInitState(state: SdkInitState) {
    if (this.initState !== state) {
      throw new Error(`Init state ${this.initState} !== ${state}`);
    }
  }

  private async setLocalDataVersion(version: number) {
    await this.db.addKey('dataVersion', Buffer.from([version]));
  }

  private async getLocalDataVersion() {
    const result = await this.db.getKey('dataVersion');
    return result ? result.readInt8(0) : 0;
  }

  private async getLocalRollupContractAddress() {
    const result = await this.db.getKey('rollupContractAddress');
    return result ? new EthAddress(result) : undefined;
  }

  private async getLocalVerifierContractAddress() {
    const result = await this.db.getKey('verifierContractAddress');
    return result ? new EthAddress(result) : undefined;
  }

  private async getLocalSyncedToRollup() {
    return +(await this.leveldb.get('syncedToRollup').catch(() => -1));
  }

  private async getCrsData(circuitSize: number) {
    this.debug('downloading crs data...');
    const crs = new NetCrs(circuitSize);
    await crs.init();
    this.debug('done.');
    return Buffer.from(crs.getData());
  }

  /**
   * Loads known accounts from db.
   * Registers to forward any notifications of account state updates.
   */
  private async initUserStates() {
    this.debug('initializing user states...');
    const users = await this.db.getUsers();
    await this.addInitialUserSpendingKeys(users.map(x => x.accountPublicKey));
    this.userStates = await Promise.all(users.map(u => this.userStateFactory.createUserState(u)));
    this.userStates.forEach(us =>
      us.on(UserStateEvent.UPDATED_USER_STATE, id => {
        this.emit(SdkEvent.UPDATED_USER_STATE, id);
        this.broadcastChannel?.postMessage({
          event: SdkEvent.UPDATED_USER_STATE,
          args: [id.toString()],
        });
      }),
    );
  }

  private async addInitialUserSpendingKeys(userIds: GrumpkinAddress[]) {
    if (!userIds.length) {
      return;
    }
    const genesisAccountsData = await this.retrieveGenesisData();
    if (genesisAccountsData.length) {
      const spendingKeys = await getUserSpendingKeysFromGenesisData(
        userIds,
        genesisAccountsData,
        this.pedersen,
        this.sdkStatus.rollupSize,
      );
      this.debug(`found ${spendingKeys.length} spending keys for user${userIds.length == 1 ? '' : 's'}`);
      if (spendingKeys.length) {
        await this.db.addSpendingKeys(spendingKeys);
      }
    }
  }

  private computeAliasHash(alias: string) {
    return AliasHash.fromAlias(alias, this.blake2s);
  }

  private async createJoinSplitProofCreator(proverless: boolean) {
    if (this.defiDepositProofCreator) {
      return;
    }

    const fft = await this.fftFactory.createFft(JoinSplitProver.getCircuitSize(proverless));
    const unrolledProver = new UnrolledProver(
      this.workerPool ? this.workerPool.workers[0] : this.barretenberg,
      this.pippenger,
      fft,
    );
    this.joinSplitProver = new JoinSplitProver(unrolledProver, proverless);
    this.paymentProofCreator = new PaymentProofCreator(
      this.joinSplitProver,
      this.noteAlgos,
      this.worldState,
      this.grumpkin,
      this.db,
    );
    this.defiDepositProofCreator = new DefiDepositProofCreator(
      this.joinSplitProver,
      this.noteAlgos,
      this.worldState,
      this.grumpkin,
      this.db,
    );
  }

  private async createAccountProofCreator(proverless: boolean) {
    if (this.accountProofCreator) {
      return;
    }

    const fft = await this.fftFactory.createFft(AccountProver.getCircuitSize(proverless));
    const unrolledProver = new UnrolledProver(
      this.workerPool ? this.workerPool.workers[0] : this.barretenberg,
      this.pippenger,
      fft,
    );
    this.accountProver = new AccountProver(unrolledProver, proverless);
    this.accountProofCreator = new AccountProofCreator(this.accountProver, this.worldState, this.db);
  }

  private async computeJoinSplitProvingKey() {
    this.debug('release account proving key...');
    await this.accountProver.releaseKey();
    this.debug('computing join-split proving key...');
    await this.joinSplitProver.computeKey();
    this.debug('done.');
  }

  private async computeAccountProvingKey() {
    this.debug('release join-split proving key...');
    await this.joinSplitProver.releaseKey();
    this.debug('computing account proving key...');
    await this.accountProver.computeKey();
    this.debug('done.');
  }

  /**
   * If the world state has no data, download the initial world state data and process it.
   */
  private async genesisSync(commitmentsOnly = false) {
    if (this.worldState.getSize() > 0) {
      return;
    }

    this.debug('initializing genesis state from server...');
    const genesisTimer = new Timer();
    const initialState = await this.rollupProvider.getInitialWorldState();
    this.debug(
      `received genesis state with ${initialState.initialAccounts.length} bytes and ${initialState.initialSubtreeRoots.length} sub-tree roots`,
    );
    await this.db.setGenesisData(initialState.initialAccounts);
    await this.worldState.insertElements(0, initialState.initialSubtreeRoots);
    if (!commitmentsOnly) {
      const accounts = InitHelpers.parseAccountTreeData(initialState.initialAccounts);
      const genesisData = parseGenesisAliasesAndKeys(accounts);
      this.debug(`storing aliases to db...`);
      await this.db.addAliases(genesisData.aliases);
    }
    this.debug(`genesis sync complete in ${genesisTimer.s()}s`);
  }

  /**
   * Starts a micro task that repeatedly calls sync() on the serial queue.
   * sync() will only process so much data at a time. We sleep for 10s between calls only if we're fully synched.
   * If we're not fully synched, we loop around immediately to process more data.
   * This mechanism ensures we don't starve servicing the serial queue for long periods of time.
   * Will return once destroy() is called and the state shifts to STOPPING.
   */
  private startReceivingBlocks() {
    this.synchingPromise = (async () => {
      this.debug('starting sync task...');
      while (this.initState !== SdkInitState.STOPPING) {
        const timer = new Timer();
        try {
          await this.serialQueue.push(() => this.sync());
        } catch (err) {
          this.debug('sync() failed:', err);
          await this.syncSleep.sleep(10000);
        }
        if (this.isSynchronised() && this.userStates.every(us => us.isSynchronised(this.sdkStatus.latestRollupId))) {
          await this.syncSleep.sleep(this.options.pollInterval || 10000);
        } else if (timer.s() < 1) {
          // Ensure that at least 1s has passed before we loop around again.
          await this.syncSleep.sleep(1000);
        }
      }
      this.debug('stopped sync task.');
    })();
  }

  /**
   * Called when data root is not as expected. We need to erase the db and rebuild the merkle tree.
   */
  private async reinitDataTree() {
    this.debug('re-initializing data tree...');

    await this.leveldb.clear();

    const subtreeDepth = Math.ceil(
      Math.log2(this.sdkStatus.rollupSize * WorldStateConstants.NUM_NEW_DATA_TREE_NOTES_PER_TX),
    );
    await this.worldState.init(subtreeDepth);
    await this.genesisSync(true);
  }

  /**
   * Every time called, determine the lowest `from` block, and download and process the next chunk of blocks.
   * Will always first bring the data tree into sync, and then forward the blocks onto user states.
   * This is always called on the serial queue.
   */
  private async sync() {
    this.treeSyncCount++;
    await this.syncBlocks();
    this.treeSyncCount--;
  }

  private async syncBlocks() {
    const currentTreeSyncCount = this.treeSyncCount;
    // Persistent data could have changed underfoot. Ensure this.sdkStatus and user states are up to date first.
    await this.readSyncInfo();
    await Promise.all(this.userStates.map(us => us.syncFromDb()));

    const { syncedToRollup } = this.sdkStatus;
    const from = syncedToRollup + 1;
    const reallyOldSize = this.worldState.getSize();

    // First we focus on bringing the core in sync (mutable data tree layers and accounts).
    // Server will return a chunk of blocks.
    const timer = new Timer();
    const coreBlocks = await this.rollupProvider.getBlocks(from);
    if (coreBlocks.length) {
      this.debug(`creating contexts for blocks ${from} to ${from + coreBlocks.length - 1}...`);
    }
    const coreBlockContexts = coreBlocks.map(b => BlockContext.fromBlock(b, this.pedersen));

    if (coreBlocks.length) {
      // For debugging corrupted data root.
      const oldRoot = this.worldState.getRoot();

      const rollups = coreBlockContexts.map(b => b.rollup);
      const offchainTxData = coreBlocks.map(b => b.offchainTxData);
      const subtreeRoots = coreBlocks.map(block => block.subtreeRoot!);
      this.debug(`inserting ${subtreeRoots.length} rollup roots into data tree...`);
      const oldSize = this.worldState.getSize();
      await this.worldState.insertElements(rollups[0].dataStartIndex, subtreeRoots);
      this.debug(`processing aliases...`);
      await this.processAliases(rollups, offchainTxData);
      await this.writeSyncInfo(rollups[rollups.length - 1].rollupId);

      // TODO: Ugly hotfix. Find root cause.
      // We expect our data root to be equal to the new data root in the last block we processed.
      // UPDATE: Possibly solved. But leaving in for now. Can monitor for clientLogs.
      const expectedDataRoot = rollups[rollups.length - 1].newDataRoot;
      const newRoot = this.worldState.getRoot();
      if (!newRoot.equals(expectedDataRoot)) {
        const newSize = this.worldState.getSize();
        await this.reinitDataTree();
        await this.writeSyncInfo(-1);
        await this.rollupProvider.clientLog({
          message: 'Invalid dataRoot.',
          synchingFromRollup: syncedToRollup,
          blocksReceived: coreBlocks.length,
          oldRoot: oldRoot.toString('hex'),
          newRoot: newRoot.toString('hex'),
          newSize,
          oldSize,
          reallyOldSize,
          expectedDataRoot: expectedDataRoot.toString('hex'),
          currentTreeSyncCount,
        });
        return;
      }

      this.debug(`forwarding blocks to user states...`);
      await Promise.all(this.userStates.map(us => us.processBlocks(coreBlockContexts)));

      this.debug(`finished processing blocks ${from} to ${from + coreBlocks.length - 1} in ${timer.s()}s...`);
    }

    // Secondly we want bring user states in sync. Determine the lowest block.
    const userSyncedToRollup = Math.min(...this.userStates.map(us => us.getUserData().syncedToRollup));

    // If it's lower than we downloaded for core, fetch and process blocks.
    if (userSyncedToRollup < syncedToRollup) {
      const timer = new Timer();
      const from = userSyncedToRollup + 1;
      this.debug(`fetching blocks from ${from} for user states...`);
      const userBlocks = await this.rollupProvider.getBlocks(from);
      this.debug(`creating contexts for blocks ${from} to ${from + userBlocks.length - 1}...`);
      const userBlockContexts = userBlocks.map(b => BlockContext.fromBlock(b, this.pedersen));
      this.debug(`forwarding blocks to user states...`);
      await Promise.all(this.userStates.map(us => us.processBlocks(userBlockContexts)));
      this.debug(
        `finished processing user state blocks ${from} to ${from + userBlocks.length - 1} in ${timer.s()}s...`,
      );
    }
  }

  /**
   * Brings this.sdkStatus, in line with whats persisted.
   */
  private async readSyncInfo() {
    const syncedToRollup = await this.getLocalSyncedToRollup();
    const latestRollupId = await this.rollupProvider.getLatestRollupId();
    this.sdkStatus.latestRollupId = latestRollupId;

    if (this.sdkStatus.syncedToRollup < syncedToRollup) {
      await this.worldState.syncFromDb();
      this.sdkStatus.syncedToRollup = syncedToRollup;
      this.sdkStatus.dataRoot = this.worldState.getRoot();
      this.sdkStatus.dataSize = this.worldState.getSize();
      this.emit(SdkEvent.UPDATED_WORLD_STATE, syncedToRollup, latestRollupId);
    }
  }

  /**
   * Persist new syncedToRollup and update this.sdkStatus.
   */
  private async writeSyncInfo(syncedToRollup: number) {
    await this.leveldb.put('syncedToRollup', syncedToRollup.toString());

    this.sdkStatus.syncedToRollup = syncedToRollup;
    this.sdkStatus.dataRoot = this.worldState.getRoot();
    this.sdkStatus.dataSize = this.worldState.getSize();

    this.emit(SdkEvent.UPDATED_WORLD_STATE, syncedToRollup, this.sdkStatus.latestRollupId);
  }

  private async processAliases(rollups: RollupProofData[], offchainTxData: Buffer[][]) {
    const processRollup = (rollup: RollupProofData, offchainData: Buffer[]) => {
      // Using a Map here to preserve insertion-order
      const aliasMap = new Map<string, Alias>();
      let offchainIndex = -1;
      for (let i = 0; i < rollup.innerProofData.length; ++i) {
        const proof = rollup.innerProofData[i];
        if (proof.isPadding()) {
          continue;
        }

        offchainIndex++;

        if (proof.proofId !== ProofId.ACCOUNT) {
          continue;
        }

        const createOrMigrate = !!toBigIntBE(proof.nullifier2);
        if (createOrMigrate) {
          const { accountPublicKey, aliasHash, spendingPublicKey1 } = OffchainAccountData.fromBuffer(
            offchainData[offchainIndex],
          );
          const commitment = this.noteAlgos.accountNoteCommitment(aliasHash, accountPublicKey, spendingPublicKey1);
          // Only need to check one commitment to make sure the aliasHash and accountPublicKey pair is valid.
          if (commitment.equals(proof.noteCommitment1)) {
            aliasMap.set(aliasHash.toString(), {
              accountPublicKey,
              aliasHash,
              index: rollup.dataStartIndex + i * 2,
            });
          }
        }
      }
      return [...aliasMap.values()];
    };

    const aliases = rollups.map((rollup, i) => processRollup(rollup, offchainTxData[i])).flat();
    await this.db.addAliases(aliases);
  }

  public async queryDefiPublishStats(query: BridgePublishQuery): Promise<BridgePublishQueryResult> {
    return await this.rollupProvider.queryDefiPublishStats(query);
  }
}
