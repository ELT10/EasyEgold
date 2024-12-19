const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const amqp = require("amqplib/callback_api");
const { Web3 } = require("web3");
const axios = require("axios");

// Connect to MongoDB Atlas
// mongoose.connect(
//   "mongodb+srv://l__1_0:-5yjt..TVhEkMsT@cluster0.fouynfh.mongodb.net/easyEgold"
// );
//local connection
mongoose.connect("mongodb://127.0.0.1:27017/easyEgold");

// Create a schema and model for the Amount
const amountSchema = new mongoose.Schema(
  {
    userInput: Number,
    outputAmount: Number,
    serverAddress: String,
    userAddress: String,
    tokenSymbol: String,
    network: String,
    otp: String,
    createdAt: Date,
  },
  { collection: "easytxs" }
);

const Amount = mongoose.model("Amount", amountSchema);

// Add token configuration
const TOKEN_CONFIG = {
  EGOLD: {
    symbol: "EGOLD",
    decimals: 18,
    minAmount: 0.000001,
    network: "BSC",
    padLength: 7,
  },
  SOL: {
    symbol: "SOL",
    decimals: 9,
    minAmount: 0.00001,
    network: "SOLANA",
    padLength: 5,
  },
};

const app = express();
app.use(bodyParser.json());
app.use(cors());

function getAddress(val) {
  if (val == "sol") {
    return "7GsiZc3AaHRpLFjxHtskaMF8htF8hgnd2Td9fE1HSKWP";
  } else {
    return "0x5528C0FD1b0E0E085313E51F583FCe3dC481bb9F";
  }
}

function generateUniqueAmount(baseAmount, otp, tokenSymbol) {
  const significantAmount = Number(baseAmount).toFixed(4);
  const cleanAmount = significantAmount.replace(/\.?0+$/, "");
  return cleanAmount + otp;
}

const queueName = "transactionQueue";

async function getSolanaPrice() {
  try {
    // Try Binance first
    const binanceResponse = await axios.get(
      "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT"
    );
    return parseFloat(binanceResponse.data.price);
  } catch (error) {
    try {
      // Fallback to Kraken
      const krakenResponse = await axios.get(
        "https://api.kraken.com/0/public/Ticker?pair=SOLUSD"
      );
      return parseFloat(krakenResponse.data.result.SOLUSD.c[0]);
    } catch (error) {
      try {
        // Fallback to Huobi
        const huobiResponse = await axios.get(
          "https://api.huobi.pro/market/detail/merged?symbol=solusdt"
        );
        return huobiResponse.data.tick.close;
      } catch (error) {
        // Final fallback to CoinGecko
        const geckoResponse = await axios.get(
          "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
        );
        return geckoResponse.data.solana.usd;
      }
    }
  }
}

async function getEgoldPrice() {
  try {
    const PANCAKESWAP_ROUTER_ABI = [
      {
        inputs: [
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "address[]", name: "path", type: "address[]" },
        ],
        name: "getAmountsOut",
        outputs: [
          { internalType: "uint256[]", name: "amounts", type: "uint256[]" },
        ],
        stateMutability: "view",
        type: "function",
      },
    ];

    const PANCAKESWAP_ROUTER_ADDRESS =
      "0x10ED43C718714eb63d5aA57B78B54704E256024E";
    const EGOLD_ADDRESS = "0xBE76F927d274072266caDe09Daa54750cd4293a1"; 
    const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
    const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
    const web3 = new Web3("https://bsc-dataseed1.binance.org");
    const contract = new web3.eth.Contract(
      PANCAKESWAP_ROUTER_ABI,
      PANCAKESWAP_ROUTER_ADDRESS
    );

    // Get EGOLD/BUSD price
    const amountIn = web3.utils.toWei("1", "ether"); // 1 EGOLD
    const amounts = await contract.methods
      .getAmountsOut(amountIn, [EGOLD_ADDRESS, USDT_ADDRESS])
      .call();

    const egoldPriceUSD = web3.utils.fromWei(amounts[1], "ether");

    const solPriceUSD = await getSolanaPrice();

    // Convert EGOLD price to SOL
    const egoldPriceInSOL = parseFloat(egoldPriceUSD) / solPriceUSD;

    return {
      usdPrice: parseFloat(egoldPriceUSD),
      solPrice: egoldPriceInSOL,
    };
  } catch (error) {
    console.error("Error fetching EGOLD price:", error);
    throw error;
  }
}

// Add a queue connection handler
let channel = null;

// Setup AMQP connection
function setupAMQP() {
  amqp.connect("amqp://127.0.0.1", (error, connection) => {
    if (error) {
      console.error("AMQP Connection Error:", error);
      setTimeout(setupAMQP, 5000); // Retry connection after 5 seconds
      return;
    }

    connection.createChannel((err, ch) => {
      if (err) {
        console.error("AMQP Channel Error:", err);
        return;
      }

      channel = ch;
      channel.assertQueue(queueName, { durable: true });

      console.log("AMQP connection established");
    });

    connection.on("error", (err) => {
      console.error("AMQP Connection Error:", err);
      setTimeout(setupAMQP, 5000);
    });
  });
}

setupAMQP();

// Add function to check queue for OTP
function checkQueueForOTP(otp) {
  return new Promise((resolve, reject) => {
    if (!channel) {
      console.warn("AMQP channel not ready");
      resolve(false);
      return;
    }

    // Remove noAck option to prevent auto-acknowledgment
    channel.get(queueName, (err, msg) => {
      if (err) {
        console.error("Queue check error:", err);
        reject(err);
        return;
      }

      if (!msg) {
        resolve(false);
        return;
      }

      try {
        const messages = JSON.parse(msg.content.toString());
        const otpExists = Array.isArray(messages)
          ? messages.some((m) => m.otp === otp)
          : messages.otp === otp;
        
        // Put the message back in the queue
        channel.nack(msg, false, true);
        
        resolve(otpExists);
      } catch (error) {
        console.error("Queue message parse error:", error);
        // Put the message back in the queue even if parsing fails
        channel.nack(msg, false, true);
        resolve(false);
      }
    });
  });
}

// Update the generateOtp function to check both DB and queue
async function generateOtp(tokenSymbol = "SOL") {
  const config = TOKEN_CONFIG[tokenSymbol];
  if (!config) {
    throw new Error(`Unsupported token: ${tokenSymbol}`);
  }

  let otp;
  let isUnique = false;
  let attempts = 0;
  const MAX_ATTEMPTS = 10;

  while (!isUnique && attempts < MAX_ATTEMPTS) {
    otp = String(Math.floor(Math.random() * 3000)).padStart(
      config.padLength,
      "0"
    );

    // Check both database and queue
    const [dbExists, queueExists] = await Promise.all([
      Amount.findOne({ otp: otp }),
      checkQueueForOTP(otp),
    ]);

    if (!dbExists && !queueExists) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique) {
    throw new Error("Failed to generate unique OTP after maximum attempts");
  }

  return otp;
}

// Update submit-amount endpoint to include queue handling
app.post("/submit-amount", async (req, res) => {
  try {
    const { amount, receiverAddr, tokenSymbol = "SOL" } = req.body;

    // Get prices
    const prices = await getEgoldPrice();

    // Generate unique OTP
    const otp = await generateOtp(tokenSymbol);

    // Calculate and format amount
    const baseAmount = tokenSymbol === "SOL" ? Number(prices.solPrice) : amount;

    const uniqueAmount = generateUniqueAmount(baseAmount, otp, tokenSymbol);
    console.log("otp", otp, " amount-", uniqueAmount);

    const address = getAddress(tokenSymbol.toLowerCase());
    const userAdd = !receiverAddr || receiverAddr === "..." ? "" : receiverAddr;

    // Create transaction object
    const transaction = {
      userInput: amount,
      outputAmount: uniqueAmount,
      serverAddress: address,
      userAddress: userAdd,
      tokenSymbol,
      network: TOKEN_CONFIG[tokenSymbol].network,
      otp,
      createdAt: new Date(),
    };

    // Save to database
    const newAmount = new Amount(transaction);
    await newAmount.save();

    // Add to queue
    if (channel) {
      channel.sendToQueue(queueName, Buffer.from(JSON.stringify(transaction)), {
        persistent: true,
      });
    } else {
      console.warn("AMQP channel not ready, transaction not queued");
    }

    res.json({
      address,
      uniqueAmount,
      network: TOKEN_CONFIG[tokenSymbol].network,
    });
  } catch (error) {
    console.error("Error in submit-amount:", error);
    res.status(500).send(error.message);
  }
});

// // Add queue cleanup function
// function cleanupExpiredTransactions() {
//   if (!channel) return;

//   channel.get(queueName, { noAck: true }, (err, msg) => {
//     if (err || !msg) return;

//     try {
//       const transaction = JSON.parse(msg.content.toString());
//       const createdAt = transaction.createdAt || new Date();

//       // Remove transactions older than 30 minutes
//       if (new Date() - new Date(createdAt) > 30 * 60 * 1000) {
//         channel.ack(msg);
//       } else {
//         // Put it back in the queue
//         channel.nack(msg, false, true);
//       }
//     } catch (error) {
//       console.error("Queue cleanup error:", error);
//     }
//   });
// }

// // Run cleanup every 5 minutes
// setInterval(cleanupExpiredTransactions, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
