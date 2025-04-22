import express, { Request, Response, Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import dotenv from 'dotenv';
import pLimit from 'p-limit';
import cors from 'cors';
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
// notifications
import { default as admin } from 'firebase-admin';

const serviceAccount = {
  projectId: "manna-lightning-429f8",
  privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCWUtfbSvyZ5MqW\nsxuosoXqVR8JLCjGqF69XX92x5diIs1iGSdOFitvaEy8vQ2phpgGsFwCGIvL7U5e\nmp7QNYyWH4TllOkYLvDJaz4fsqw3eLMhxGWvEEa+MXl52hoC0jszykDWBTQkTsql\nAM0jV5wPXlVCSg3m0Z6FBqPERldVHAek172okGckctWFh7NU3EjUshOxm65GXZXX\nG2JWiPt3Ij91nmiKgxsLltDp0ihcBqxJP41vfc0/zpOY4nIjPKV+Iqz4QfC19KjZ\noSX4mV/JKRQHGAXnWGyGSjyGfAX+FdnOMSGOCMH2sS2O/SApJQvNQPL5vG7VRjrl\nO15KWT/vAgMBAAECggEANcIImc7WSP7OCFijIpA9XdD1GWWma2zY/KWMKOE13Q2P\nH27ZZI5/GAdXsgN1+FM+2N2G+eTnUZVa+nAXLWSJE0LQVv4K4fAfghiNDe7qsafD\nf+bpalLKyceNpqr9tFaUf2/sAd24iOd4hsujkOkK0WAt41fyYsJCC1aViGKTZsbj\n6wsDBWGxWIQfOe8UA59nQlvrexXVt65L0/iXifFrXUBzZraKLcjUdkF0ymRfhhdt\nsxDdb4/uK9b7uo2TvDbDKBZA9aWGkuxxcImY8IqcooBM4n2/UToiTfP3rja+Not0\n/37zpNamJ7jzOjxIGtfU93xzk1NeI40Ki2gikmkCSQKBgQDNf2ta+YrzrguiLxAE\ntG7P0Gf+vqhFdgLNJuY9AYRod7Z5IfF0nMiRTFmy3ysbe7GLWqHq/4P1nKFF5r+K\nWfvGwtmcRKkS52W6K1xml8F0XFT/ru9iVo/JC1B+yt5BbueXAlMF+lmayoSdgwgo\n/RQNB425foe0RtfIZFzGlHiJ1QKBgQC7RDoKiBWTgg2BJuJP4nwZitMk5Xq8QltV\n3/JvId3LaD05oJACIsJd+mBPeCnrIWEBDb1nXJg/x2J7G37L715vLXrXI5LKd+ru\nlSgJd4CfNDGkDF5nTeBFGwacwTF5OI4G6BfKP001Gyp85ZcRjLDolZocs62QTrdY\nfbdeZF1gswKBgQCSEzNC9gP5+Aw4+29NiN0ESEbEZM7EoYCYSEB9uShgAkjpjmFO\n3WwNLNLOPaks3h50yrYyj/NDklVplP8u34wD29pIJN5ym55KWixSmSlhB4k8PyPX\nKWUIKkzL9HVM2gMx6usNYspzJ+Zg+RXB3TR1lpr98p2QXpNg1UbFuiB9CQKBgQCD\n2BQ5J/hw4yaY4ISDk8SlwwzHNF3GP73IZyRrw99A/4HjmbzqFAjeW5IFQWfZ6KVA\nNak9JX73oGwgmooaEMxe4BlVcPE/ZVBda1xF1gITlI7Cnga1GqokXVO5d3dajkvI\nZw2g0hKMqjSuvIIw0+oVxoY7YPF44ULKpbA9X9IyawKBgQCPKXcaFQMjyPm+G3+J\nPXVtfrYBMY73Zz1Qb52AfFXXWPYsfG9CiE+JJY5rGmCKxHKVIYHdby/AtQ0QSw1+\nvLQ5jBOP0X97clISioX5a42lCIsUkflFC4MbUWN7P8BtSyoIh8/dreG7wv1rJB+s\nxXyAl4fOzKgF3lrPjW9dIoyFPg==\n-----END PRIVATE KEY-----\n",
  clientEmail: "firebase-adminsdk-nibib@manna-lightning-429f8.iam.gserviceaccount.com",
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const messaging = admin.messaging();


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
    .select('*')
    .eq('user_name', userName)
    .maybeSingle();

  if (!data) {
    sendNotification(data!.fcm_token,'Wow', 'Notifications');
    res.status(200).json({
      status: 'ERROR',
      reason: 'Unable to find valid user wallet.',
    });
    return;
  }

  const responseData: LNURLPayResponse = {
    callback: `${req.protocol}://${req.get('host')}/payreq/${data.uuid}`,
    maxSendable: 25000000000,
    minSendable: 100000,
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
  const note = (req.query.note || req.query.label || req.query.comment || req.query.message) as string | undefined;
  const amountValue = parseInt(amount || '', 10);

  if (!amount || isNaN(amountValue) || amountValue < 100000 || amountValue > 25000000000) {
    res.status(404).json({
      status: 'ERROR',
      reason: amount
        ? 'Amount is not within valid millisatoshi limits: 100000 - 25000000000'
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

  const txId = (await axios.post(`${process.env.BOLTZ_API_URL}/chain/L-BTC/transaction`, { hex: claimTransaction.toHex() })).data.id;
  await supabase.from('swaps').update({ claim_tx_id: txId }).eq('swap_id', swapData.swap_id);

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
app.use(cors());
app.use(express.json());
app.use(router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const limit = pLimit(5);
const processExistingSwaps = async () => {
  const { data: swaps } = await supabase.from('swaps').select('*').in('status', ['swap.created', 'transaction.mempool']).gte('created_at', new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString());
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


const sendNotification = async (fcmToken: string, title: string, body: string) => {
  const res = await messaging.send({
    token: fcmToken,
    notification: {
      title: title,
      body: body,
    },
    // extra data.
    data: {}
  });
  console.log(`Notification sent! ${res}`);
};