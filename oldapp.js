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
  },
  { collection: "easytxs" }
);

const Amount = mongoose.model("Amount", amountSchema);

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

// function isUnique(otp) {
//   return !db.some(entry => entry.otp === otp) && !queue.includes(otp);
// }

//change padstart value for each token based on token price
function generateOtp() {
  while (true) {
    const otp = String(Math.floor(Math.random() * 3000)).padStart(7, "0");

    // Check if the OTP is unique in both the database and queue
    // if (isUnique(otp)) {
    return otp;
    // }
  }
}

function generateUniqueAmount(baseAmount) {
  return baseAmount + "." + generateOtp(); // Example logic
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
    const EGOLD_ADDRESS = "0xBE76F927d274072266caDe09Daa54750cd4293a1"; // Replace with actual EGOLD token address
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

    console.log("amntss", amounts);
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

// POST route to receive amount and respond with OTP
app.post("/submit-amount", async (req, res) => {
  try {
    const prices = await getEgoldPrice();
    console.log(
      "EGOLD Price:",
      prices.usdPrice,
      "USD,",
      prices.solPrice,
      "SOL"
    );

    console.log("in hererere", req.body);
    const { amount, receiverAddr } = req.body;
    console.log("amt-", amount, receiverAddr);

    const uniqueAmount = generateUniqueAmount(Number(prices.solPrice));
    console.log("uniqueAmount", uniqueAmount);

    const address = getAddress("sol");

    if (!receiverAddr || receiverAddr == "...") {
      var userAdd = "";
    } else {
      var userAdd = receiverAddr;
    }

    const newAmount = new Amount({
      userInput: amount,
      outputAmount: uniqueAmount,
      serverAddress: address,
      userAddress: userAdd,
      state: "init",
    });
    await newAmount.save();

    // amqp.connect("amqp://127.0.0.1", (error, connection) => {
    //   if (error) throw error;

    //   connection.createChannel((error, channel) => {
    //     if (error) throw error;

    //     const job = { amount: uniqueAmount };
    //     channel.assertQueue(queueName, { durable: true });
    //     channel.sendToQueue(queueName, Buffer.from(JSON.stringify(job)), {
    //       persistent: true,
    //     });
    //   });
    // });

    res.json({ address, uniqueAmount });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
