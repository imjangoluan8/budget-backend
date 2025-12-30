const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const app = express();
app.use(express.json());
app.use(cors());

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

console.log("Node version:", process.version);
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Schemas
const bankSchema = new mongoose.Schema({
  name: String,
  balance: Number,
  budgetCode: { type: String, required: true },
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
  budgetCode: { type: String, required: true },
});
const Transaction = mongoose.model("Transaction", transactionSchema);

// Ensure default bank
async function ensureDefaultBank(code) {
  let bank = await Bank.findOne({
    name: "Payroll Bank(RBANK)",
    budgetCode: code,
  });
  if (!bank) {
    bank = new Bank({
      name: "Payroll Bank(RBANK)",
      balance: 0,
      budgetCode: code,
    });
    await bank.save();
  }
  return bank;
}

function budgetCodeMiddleware(req, res, next) {
  const code = req.headers["x-budget-code"];
  if (!code) return res.status(400).send("Budget code required");
  req.budgetCode = code;
  next();
}

// Routes
app.get("/banks", budgetCodeMiddleware, async (req, res) => {
  try {
    await ensureDefaultBank();
    const banks = await Bank.find();
    res.json(banks);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post("/banks", budgetCodeMiddleware, async (req, res) => {
  const { name, balance } = req.body;
  if (name === "Payroll Bank(RBANK)")
    return res.status(400).send("Default bank already exists");
  const bank = new Bank({ name, balance });
  await bank.save();
  res.json(bank);
});

app.delete("/banks/:id", budgetCodeMiddleware, async (req, res) => {
  const bank = await Bank.findById(req.params.id);
  if (bank.name === "Payroll Bank(RBANK)")
    return res.status(400).send("Cannot delete default bank");
  await Bank.findByIdAndDelete(req.params.id);
  res.send("Deleted");
});

// Transactions
app.get("/transactions", budgetCodeMiddleware, async (req, res) => {
  await ensureDefaultBank();
  const transactions = await Transaction.find().populate("bankId", "name");
  res.json(transactions);
});

app.post("/transactions", budgetCodeMiddleware, async (req, res) => {
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

app.delete("/transactions/:id", budgetCodeMiddleware, async (req, res) => {
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
app.get("/summary", budgetCodeMiddleware, async (req, res) => {
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

app.patch("/banks/:id", budgetCodeMiddleware, async (req, res) => {
  const { balance } = req.body;
  const bank = await Bank.findById(req.params.id);
  if (!bank) return res.status(404).send("Bank not found");
  bank.balance = balance;
  await bank.save();
  res.json(bank);
});

app.post("/transfer", budgetCodeMiddleware, async (req, res) => {
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
