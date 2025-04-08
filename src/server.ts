import express, { Request, Response, Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import dotenv from 'dotenv';
import pLimit from 'p-limit';
import {
  User,
  Swap,
  LNURLPayResponse,
  BoltzResponse,
  LockupTransactionResponse,
  BoltzClaimResponse
} from './types.js';

// for swap
import { randomBytes } from 'crypto';
import { ECPairFactory } from 'ecpair';
import { Transaction, address as LiquidAddress, crypto, networks } from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';
// for claim
import {
  Musig,
  OutputType,
  SwapTreeSerializer,
  detectSwap,
  targetFee,
} from 'boltz-core';
import { TaprootUtils as LiquidTaprootUtils, constructClaimTransaction } from "boltz-core/dist/lib/liquid/index.js";
import { init } from 'boltz-core/dist/lib/liquid/init.js';
import { default as zkpInit, Secp256k1ZKP } from '@vulpemventures/secp256k1-zkp';
import { LiquidSwapTree } from 'boltz-core/dist/lib/consts/Types.js';


dotenv.config();
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error('Missing required environment variables');
}

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

let zkp: Secp256k1ZKP;
(async () => {
  zkp = await zkpInit.default();
  init(zkp);
})();

// LNURL-pay endpoint
router.get('/.well-known/lnurlp/:username', async (req: Request, res: Response): Promise<void> => {
  const userName = req.params.username;
  const { data } = await supabase
    .from('users')
    .select('uuid')
    .eq('user_name', userName)
    .maybeSingle();

  if (!data) {
    res.status(200).json({
      status: 'ERROR',
      reason: 'Unable to find valid user wallet.',
    });
    return;
  }

  const responseData: LNURLPayResponse = {
    callback: `${req.protocol}://${req.get('host')}/payreq/${data.uuid}`,
    maxSendable: 25000000000,
    minSendable: 1000000,
    metadata: JSON.stringify([
      ['text/plain', `Pay to manna wallet user: ${userName}`],
      ['text/identifier', `${userName}@mannabitcoin.com`],
    ]),
    commentAllowed: 255,
    tag: 'payRequest',
  };

  res.json(responseData);
});

// Callback endpoint for generating Bolt11 invoice
router.get('/payreq/:uuid', async (req: Request, res: Response): Promise<void> => {
  console.log('payreq', req.params, req.query);
  const uuid = req.params.uuid;
  const amount = req.query.amount as string;
  const note = (req.query.note || req.query.label) as string | undefined;
  const amountValue = parseInt(amount || '', 10);

  if (!amount || isNaN(amountValue) || amountValue < 1000000 || amountValue > 25000000000) {
    res.status(404).json({
      status: 'ERROR',
      reason: amount
        ? 'Amount is not within valid millisatoshi limits: 1000000 - 25000000000'
        : 'amount not supplied',
    });
    return;
  }

  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('uuid', uuid)
    .maybeSingle();

  if (!data) {
    res.status(404).json({
      status: 'ERROR',
      reason: 'LNURL Pay Transaction does not exist.',
    });
    return;
  }

  const user = data as User;
  const liquidAddress = user.liquid_addresses.length > 0
    ? user.liquid_addresses[0]
    : user.used_addresses.length > 0
      ? user.used_addresses[0]
      : null;

  if (!liquidAddress) {
    res.status(404).json({
      status: 'ERROR',
      reason: 'No liquid address found.',
    });
    return;
  }

  const preimage = randomBytes(32);
  const preimageHash = crypto.sha256(preimage).toString('hex');
  const keys = ECPairFactory(ecc).makeRandom();
  const privKeyHex = Buffer.from(keys.privateKey).toString('hex');
  const pubKeyHex = Buffer.from(keys.publicKey).toString('hex');
  const liquidAddressHash = crypto.sha256(Buffer.from(liquidAddress, 'utf-8'));
  const addressSignature = Buffer.from(keys.signSchnorr(liquidAddressHash)).toString('hex');
  const noteText = note ?? 'Payment to manna wallet user: ' + user.user_name;

  try {
    const boltzData = (await axios.post<BoltzResponse>(`${process.env.BOLTZ_API_URL}/swap/reverse`, {
      invoiceAmount: Math.floor(amountValue / 1000),
      to: 'L-BTC',
      from: 'BTC',
      // claimCovenant: false,
      claimPublicKey: pubKeyHex,
      preimageHash: preimageHash,
      claimAddress: liquidAddress,
      address: liquidAddress,
      addressSignature: addressSignature,
      description: noteText,
      referralId: 'Manna',
      webhook: {
        url: `https://${req.get('host')}/webhook/swap`,
      }
    })).data;

    // Update user's addresses
    const index = user.liquid_addresses.indexOf(liquidAddress);
    if (index !== -1) {
      user.liquid_addresses.splice(index, 1);
    }
    user.used_addresses.push(liquidAddress);

    await supabase
      .from('users')
      .update({
        liquid_addresses: Array.from(new Set(user.liquid_addresses)),
        used_addresses: Array.from(new Set(user.used_addresses)),
      })
      .eq('uuid', uuid);

    const swap: Swap = {
      swap_id: boltzData.id,
      status: 'swap.created',
      wallet_id: user.uuid,
      amount: amount,
      note: noteText,
      preImage: preimage.toString('hex'),
      preImageHash: preimageHash,
      privateKey: privKeyHex,
      pubKey: pubKeyHex,
      claimAddress: liquidAddress,
      invoice: boltzData.invoice,
      swapTree: JSON.stringify(boltzData.swapTree),
      lockupAddress: boltzData.lockupAddress,
      refundPubKey: boltzData.refundPublicKey,
      timeoutBlockHeight: boltzData.timeoutBlockHeight,
      onChainAmount: boltzData.onchainAmount,
      blindingKey: boltzData.blindingKey,
    };

    await supabase.from('swaps').insert(swap);

    res.json({
      pr: boltzData.invoice,
      route: []
    });
    return;
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({
      status: 'ERROR',
      reason: 'Failed to generate invoice',
    });
  }
});

const claimSwap = async (swapId: string) => {
  const { data } = await supabase
    .from('swaps')
    .select('*')
    .eq('swap_id', swapId)
    .maybeSingle();

  if (!data) {
    throw new Error('Swap not found');
  }

  const swapData = data as Swap;
  const transaction = await axios.get<LockupTransactionResponse>(`${process.env.BOLTZ_API_URL}/swap/reverse/${swapId}/transaction`);
  if (!transaction) {
    throw new Error('Transaction not found');
  }

  const claimTransaction = await createReverseClaimTransaction(swapData, transaction.data.hex, true);
  if (!claimTransaction) {
    throw new Error('Failed to generate claim transaction');
  }

  await axios.post(`${process.env.BOLTZ_API_URL}/chain/L-BTC/transaction`, { hex: claimTransaction.toHex() });
  console.log('Claim transaction broadcast successfully');
}

const createReverseClaimTransaction = async (
  swapData: Swap,
  transactionHex: string,
  cooperative: boolean = true,
): Promise<Transaction | undefined> => {
  console.log(`Claiming Taproot swap cooperatively: ${cooperative}`);
  const keys: ECPairFactory = ECPairFactory(ecc).fromPrivateKey(Buffer.from(swapData.privateKey, 'hex'));
  const boltzPublicKey = Buffer.from(swapData.refundPubKey, 'hex');
  const swapTree = SwapTreeSerializer.deserializeSwapTree(swapData.swapTree) as LiquidSwapTree;
  const publicKey = Buffer.from(keys.publicKey);
  const lockupTx = Transaction.fromHex(transactionHex);
  const preimage = Buffer.from(swapData.preImage, 'hex');
  const swapBlindingKey = Buffer.from(swapData.blindingKey, 'hex');

  const musig = new Musig(zkp, keys, randomBytes(32), [boltzPublicKey, publicKey]);
  const tweakedKey = LiquidTaprootUtils.tweakMusig(musig, swapTree.tree);
  const swapOutput = detectSwap(tweakedKey, lockupTx);

  if (!swapOutput) {
    throw new Error('No swap output found in lockup transaction');
  }

  const claimScript = LiquidAddress.toOutputScript(swapData.claimAddress, networks.liquid);
  const claimTxBlindingKey = LiquidAddress.fromConfidential(swapData.claimAddress).blindingKey;

  const claimTx = targetFee(0.1, (fee) =>
    constructClaimTransaction(
      [{
        ...swapOutput,
        cooperative,
        swapTree,
        keys,
        preimage,
        type: OutputType.Taproot,
        txHash: lockupTx.getHash(),
        blindingPrivateKey: swapBlindingKey,
        internalKey: musig.getAggregatedPublicKey(),
      }],
      claimScript,
      fee,
      true,
      networks.liquid,
      claimTxBlindingKey,
    ), true,
  );
  if (!cooperative) {
    return claimTx;
  }

  try {
    const boltzSig = (
      await axios.post<BoltzClaimResponse>(
        `${process.env.BOLTZ_API_URL}/swap/reverse/${swapData.swap_id}/claim`,
        {
          index: 0,
          transaction: claimTx.toHex(),
          preimage: swapData.preImage,
          pubNonce: Buffer.from(musig.getPublicNonce()).toString('hex'),
        },
      )
    ).data;

    musig.aggregateNonces([[boltzPublicKey, Buffer.from(boltzSig.pubNonce, 'hex')]]);
    musig.initializeSession(
      claimTx.hashForWitnessV1(
        0,
        [swapOutput.script],
        [{ value: swapOutput.value, asset: swapOutput.asset }],
        Transaction.SIGHASH_DEFAULT,
        networks.liquid.genesisBlockHash,
      ),
    );
    musig.signPartial();
    musig.addPartial(boltzPublicKey, Buffer.from(boltzSig.partialSignature, 'hex'));

    claimTx.ins[0].witness = [musig.aggregatePartials()];
    return claimTx;
  } catch (e) {
    console.warn("Uncooperative Taproot claim because", e);
    return createReverseClaimTransaction(swapData, transactionHex, false);
  }
};

// Webhook endpoint for Boltz swap updates
router.post('/webhook/swap', async (req: Request, res: Response): Promise<void> => {
  if (!req.body.data || !req.body.data.id || !req.body.data.status) {
    res.json({ message: 'No data found!' });
    return;
  }

  const { id: swapId, status } = req.body.data;
  if (status !== 'transaction.mempool') {
    res.json({ message: 'Status not handled' });
    return;
  }
  console.log('webhook', req.body);
  await supabase.from('swaps').update({ status: status }).eq('swap_id', swapId);

  try {
    await claimSwap(swapId);
    res.json({ message: 'Claim transaction broadcast successfully' });
  } catch (error) {
    console.error('Error processing swap webhook:', error);
    res.status(500).json({ error: 'Failed to process swap' });
  }
});

const app = express();
app.use(express.json());
app.use(router); const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const limit = pLimit(5);
const processExistingSwaps = async () => {
  const { data: swaps } = await supabase.from('swaps').select('*').in('status', ['swap.created', 'transaction.mempool']).gte('created_at', new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString());
  console.log('swaps', swaps);
  if (!swaps || swaps.length === 0) return;

  await Promise.all(swaps.map(swap =>
    limit(async () => {
      try {
        const newStatus = (await axios.get(`${process.env.BOLTZ_API_URL}/swap/${swap.swap_id}`)).data.status;

        if (newStatus === 'transaction.mempool') {
          await claimSwap(swap.swap_id);
        }

        if (newStatus !== swap.status) {
          await supabase.from('swaps').update({ status: newStatus }).eq('swap_id', swap.swap_id);
        }
      } catch (err) {
        console.error(`Failed processing swap ${swap.swap_id}`, err);
      }
    })
  ));
};

setInterval(processExistingSwaps, 60000);