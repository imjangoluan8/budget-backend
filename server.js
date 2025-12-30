const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const app = express();
app.use(express.json());
app.use(cors());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Schemas
const bankSchema = new mongoose.Schema({
  name: String,
  balance: Number,
});
const Bank = mongoose.model("Bank", bankSchema);

const transactionSchema = new mongoose.Schema({
  type: String, // 'income' or 'expense'
  amount: Number,
  month: String,
  bankId: { type: mongoose.Schema.Types.ObjectId, ref: "Bank" },
  sourceName: String,
  destName: String,
  isLedger: { type: Boolean, default: false }, // for non-primary banks
});
const Transaction = mongoose.model("Transaction", transactionSchema);

// Ensure default bank
async function ensureDefaultBank() {
  try {
    let bank = await Bank.findOne({ name: "Payroll Bank(RBANK)" });
    if (!bank) {
      bank = new Bank({ name: "Payroll Bank(RBANK)", balance: 0 });
      await bank.save();
    }
    return bank;
  } catch (err) {
    console.error("Error ensuring default bank:", err);
    return null;
  }
}

// Routes
app.get("/banks", async (req, res) => {
  try {
    const banks = await Bank.find();
    res.json(banks);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post("/banks", async (req, res) => {
  const { name, balance } = req.body;
  if (name === "Payroll Bank(RBANK)")
    return res.status(400).send("Default bank already exists");
  const bank = new Bank({ name, balance });
  await bank.save();
  res.json(bank);
});

app.delete("/banks/:id", async (req, res) => {
  const bank = await Bank.findById(req.params.id);
  if (bank.name === "Payroll Bank(RBANK)")
    return res.status(400).send("Cannot delete default bank");
  await Bank.findByIdAndDelete(req.params.id);
  res.send("Deleted");
});

// Transactions
app.get("/transactions", async (req, res) => {
  const transactions = await Transaction.find().populate("bankId", "name");
  res.json(transactions);
});

app.post("/transactions", async (req, res) => {
  const { type, amount, month, bankId, isLedger, sourceName, destName } =
    req.body;

  const bank = bankId ? await Bank.findById(bankId) : await ensureDefaultBank();

  if (!bank) return res.status(404).send("Bank not found");

  const transaction = new Transaction({
    type,
    amount,
    month,
    bankId: bank._id,
    isLedger: !!isLedger,
    sourceName,
    destName,
  });

  await transaction.save();

  // Update bank balance
  bank.balance += type === "income" ? amount : -amount;
  await bank.save();

  res.json(transaction);
});

app.delete("/transactions/:id", async (req, res) => {
  const transaction = await Transaction.findById(req.params.id);
  if (!transaction) return res.status(404).send("Not found");

  const bank = await Bank.findById(transaction.bankId);
  bank.balance +=
    transaction.type === "income" ? -transaction.amount : transaction.amount;
  await bank.save();

  await Transaction.findByIdAndDelete(req.params.id);
  res.send("Deleted");
});

// Monthly summary
app.get("/summary", async (req, res) => {
  const transactions = await Transaction.find();
  const summaryMap = {};

  transactions.forEach((t) => {
    if (!summaryMap[t.month])
      summaryMap[t.month] = { totalIncome: 0, totalExpense: 0, balance: 0 };
    if (t.type === "income") summaryMap[t.month].totalIncome += t.amount;
    else summaryMap[t.month].totalExpense += t.amount;
    summaryMap[t.month].balance =
      summaryMap[t.month].totalIncome - summaryMap[t.month].totalExpense;
  });

  const summary = Object.keys(summaryMap)
    .sort()
    .map((month) => ({
      month,
      ...summaryMap[month],
    }));

  res.json(summary);
});

app.patch("/banks/:id", async (req, res) => {
  const { balance } = req.body;
  const bank = await Bank.findById(req.params.id);
  if (!bank) return res.status(404).send("Bank not found");
  bank.balance = balance;
  await bank.save();
  res.json(bank);
});

app.post("/transfer", async (req, res) => {
  const { sourceId, destId, amount, month } = req.body;
  if (!sourceId || !destId || !amount || !month)
    return res.status(400).send("Missing data");

  const source = await Bank.findById(sourceId);
  const dest = await Bank.findById(destId);
  if (!source || !dest) return res.status(404).send("Bank not found");
  if (amount > source.balance)
    return res.status(400).send("Insufficient balance");

  // Update balances
  source.balance -= amount;
  dest.balance += amount;
  await source.save();
  await dest.save();

  // Create two transactions
  const transactionsToCreate = [
    {
      type: "expense",
      amount,
      month,
      bankId: source._id,
      sourceName: source.name,
      destName: dest.name,
      isLedger: source.name !== "Payroll Bank(RBANK)",
    },
    {
      type: "income",
      amount,
      month,
      bankId: dest._id,
      sourceName: source.name,
      destName: dest.name,
      isLedger: dest.name !== "Payroll Bank(RBANK)",
    },
  ];

  const created = [];
  for (const t of transactionsToCreate) {
    const tr = new Transaction(t);
    await tr.save();
    created.push(tr);
  }

  res.json(created);
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
