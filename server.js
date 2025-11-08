require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const methodOverride = require('method-override');
const cron = require('node-cron');

const User = require('./models/User');
const Deposit = require('./models/Deposit');
const Page = require('./models/Page'); // <-- новая модель страницы

const app = express();

// --- Настройки EJS и статики ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static('public'));

// --- Сессии ---
app.use(session({
  secret: 'supersecretkey',
  resave: false,
  saveUninitialized: false
}));

// --- Подключение к MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected ✅'))
  .catch(err => console.log('MongoDB connection error:', err));

// =======================
// --- Функция начисления процентов ---
// =======================
async function accrueDailyInterest() {
  try {
    const deposits = await Deposit.find({ status: 'active' });
    for (const dep of deposits) {
      const user = await User.findById(dep.userId);
      if (!user) continue;

      const daysPassed = dep.daysPassed || 0;
      if (daysPassed < 30) {
        const interest = dep.principal * (dep.dailyPercent / 100);
        user.balance += interest;

        if (!user.transactions) user.transactions = [];
        user.transactions.push({
          type: 'interest',
          amount: interest,
          description: `Начислено ${dep.dailyPercent}% от депозита ${dep.principal.toFixed(2)}$ (день ${daysPassed + 1}/30)`,
          date: new Date(),
          status: 'completed'
        });

        dep.accrued += interest;
        dep.daysPassed += 1;
        dep.lastInterestDate = new Date();
        await dep.save();
        await user.save();
      } else {
        dep.status = 'completed';
        dep.lastInterestDate = new Date();
        await dep.save();

        if (!user.transactions) user.transactions = [];
        user.transactions.push({
          type: 'deposit_completed',
          amount: dep.principal,
          description: `Депозит ${dep.principal.toFixed(2)}$ завершён после 30 дней`,
          date: new Date(),
          status: 'completed'
        });
        await user.save();
      }
    }
    console.log('Начисление процентов завершено');
  } catch (err) {
    console.error('Ошибка начисления процентов:', err);
  }
}

// Cron job каждый день в 03:00
cron.schedule('0 3 * * *', () => {
  console.log('Начисление ежедневных процентов депозита - 03:00');
  accrueDailyInterest();
});

// =======================
// --- Регистрация ---
// =======================
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
  try {
    const { name, email, age, password, referralCode } = req.body;
    if (!email) return res.render('register', { error: 'Email обязателен' });
    if (age < 18) return res.render('register', { error: 'Регистрация только с 18 лет и старше' });

    const normalizedEmail = email.toLowerCase();
    const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;

    if (adminEmail && normalizedEmail !== adminEmail) {
      if (!referralCode) return res.render('register', { error: 'Реферальный код обязателен' });
      const refUser = await User.findOne({ referralCode });
      if (!refUser) return res.render('register', { error: 'Некорректный реферальный код' });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) return res.render('register', { error: 'Пользователь с таким email уже зарегистрирован' });

    const user = new User({name,
      email: normalizedEmail,
      age,
      password,
      referredBy: normalizedEmail === adminEmail ? "000001" : referralCode,
      balance: 0,
      transactions: [],
      referralCode: Math.random().toString(36).substring(2, 8).toUpperCase()
    });
    await user.save();
    req.session.userId = user._id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;

    if (normalizedEmail === adminEmail) return res.redirect('/admin');
    res.redirect('/');
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.render('register', { error: 'Ошибка регистрации: ' + err.message });
  }
});

// =======================
// --- Логин ---
// =======================
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email) return res.render('login', { error: 'Email обязателен' });

    const normalizedEmail = email.toLowerCase();
    const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
    const adminPassword = process.env.ADMIN_PASSWORD || null;

    if (normalizedEmail === adminEmail && password === adminPassword) {
      req.session.userId = "admin";
      req.session.userName = "Admin";
      req.session.userEmail = adminEmail;
      return res.redirect('/admin');
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.render('login', { error: 'Неверный email или пароль' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.render('login', { error: 'Неверный email или пароль' });

    req.session.userId = user._id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;
    res.redirect('/');
  } catch (err) {
    console.error('Ошибка входа:', err);
    res.render('login', { error: 'Ошибка входа: ' + err.message });
  }
});

// =======================
// --- Главная страница ---
// =======================
app.get('/', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  if (req.session.userId === "admin") return res.redirect('/admin');

  const user = await User.findById(req.session.userId);
  if (!user) return res.redirect('/login');
  res.render('index', { currentUser: user });
});

// =======================
// --- Депозит ---
// =======================
app.get('/deposit', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const user = await User.findById(req.session.userId);
  if (!user) return res.redirect('/login');
  res.render('deposit', { currentUser: user, error: null });
});

app.post('/start-deposit', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).send('Не авторизован');

    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).send('Пользователь не найден');

    const activeDeposit = await Deposit.findOne({ userId: user._id, status: 'active' });
    if (activeDeposit) {
      return res.render('deposit', { currentUser: user, error: 'У вас уже есть активный депозит. Дождитесь завершения.' });
    }

    const { amount } = req.body;
    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount <= 0) return res.render('deposit', { currentUser: user, error: 'Введите корректную сумму' });
    if (user.balance < numericAmount) return res.render('deposit', { currentUser: user, error: 'Недостаточно средств' });

    user.balance -= numericAmount;

    const deposit = new Deposit({
      userId: user._id,
      principal: numericAmount,
      accrued: 0,
      status: 'active',
      lastInterestDate: new Date(),
      daysPassed: 0,
      dailyPercent: 4.5});
    await deposit.save();
    if (!user.transactions) user.transactions = [];
    user.transactions.push({
      type: 'deposit',
      amount: numericAmount,
      description: `Депозит запущен: списано ${numericAmount}$`,
      date: new Date(),
      status: 'active'
    });
    await user.save();
    res.redirect('/history');
  } catch (err) {
    console.error('Ошибка POST /start-deposit:', err);
    res.status(500).send('Ошибка сервера');
  }
});

// =======================
// --- История операций ---
// =======================
app.get('/history', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const currentUser = await User.findById(req.session.userId);
  if (!currentUser) return res.redirect('/login');

  const deposits = await Deposit.find({ userId: currentUser._id }).sort({ createdAt: -1 });
  deposits.forEach(dep => dep.daysLeft = dep.status === 'active' ? 30 - (dep.daysPassed || 0) : 0);

  const transactions = currentUser.transactions || [];
  transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

  res.render('history', { currentUser, deposits, transactions });
});

// =======================
// --- Вывод средств ---
// =======================
app.get('/withdraw', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const user = await User.findById(req.session.userId);
  res.render('withdraw', { currentUser: user, error: null });
});

app.post('/withdraw', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).send('Не авторизован');

    const user = await User.findById(req.session.userId);
    const { amount, cryptoAddress } = req.body;
    const numericAmount = parseFloat(amount);

    if (!numericAmount || numericAmount <= 0) return res.render('withdraw', { currentUser: user, error: 'Введите корректную сумму' });
    if (numericAmount > user.balance) return res.render('withdraw', { currentUser: user, error: 'Сумма превышает баланс аккаунта' });

    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    if (day !== 0 || hour < 8 || hour >= 20) {
      return res.render('withdraw', { currentUser: user, error: 'Вывод доступен только в воскресенье с 08:00 до 20:00' });
    }

    const fee = numericAmount * 0.02;
    const totalDeduction = numericAmount + fee;

    if (!user.transactions) user.transactions = [];
    const tx = {
      type: 'withdraw',
      amount: numericAmount,
      fee,
      currency: 'USDT',
      date: now,
      destination: cryptoAddress,
      status: 'pending'
    };
    user.transactions.push(tx);
    user.balance -= totalDeduction;
    await user.save();

    res.render('withdraw', { currentUser: user, tx });
  } catch (err) {
    console.error('Ошибка POST /withdraw:', err);
    res.status(500).send('Ошибка сервера');
  }
});

// =======================
// --- Моя группа ---
// =======================
app.get('/group', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  if (req.session.userId === "admin") return res.redirect('/admin');

  const user = await User.findById(req.session.userId);
  if (!user) return res.redirect('/login');

  const team = await User.find({ referredBy: user.referralCode });
  res.render('group', { currentUser: user, team });
});

// =======================
// --- GrapesJS редактор ---
// =======================
app.get('/grapes/:pageName', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');

  const pageName = req.params.pageName;

  // ищем страницу или создаем пустую
  let page = await Page.findOne({ name: pageName });
  if (!page) {
    page = new Page({ name: pageName });
    await page.save();
  }

  res.render('grapes', { page });
});

app.post('/grapes/:pageName/save', async (req, res) => {
  if (!req.session.userId) return res.status(401).send('Не авторизован');

  const { html, css, js } = req.body;
  const pageName = req.params.pageName;let page = await Page.findOne({ name: pageName });
  if (!page) page = new Page({ name: pageName, html, css, js });
  else {
    page.html = html;
    page.css = css;
    page.js = js;
  }

  await page.save();
  res.json({ success: true, message: 'Страница сохранена!' });
});

// Отображение страницы сайта
app.get('/page/:pageName', async (req, res) => {
  const pageName = req.params.pageName;
  const page = await Page.findOne({ name: pageName });
  if (!page) return res.status(404).send('Страница не найдена');

  res.send(`
    <style>${page.css}</style>
    ${page.html}
    <script>${page.js}</script>`
  );
});

// =======================
// --- Выход ---
// =======================
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// =======================
// --- Админ-панель ---
// =======================
app.get('/admin', async (req, res) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
    if (!req.session.userId || req.session.userEmail.toLowerCase() !== adminEmail)
      return res.status(403).send('Доступ запрещён');

    const users = await User.find();
    res.render('admin', { users });
  } catch (err) {
    console.error('Ошибка GET /admin:', err);
    res.status(500).send('Ошибка сервера');
  }
});

app.post('/admin/deposit/:id', async (req, res) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
    if (!req.session.userId || req.session.userEmail.toLowerCase() !== adminEmail)
      return res.status(403).send('Доступ запрещён');

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).send('Пользователь не найден');

    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).send('Введите корректную сумму');

    if (!user.transactions) user.transactions = [];
    user.balance += amount;
    user.transactions.push({
      type: 'deposit',
      amount,
      description: 'Пополнение администратором',
      date: new Date(),
      status: 'completed'
    });
    await user.save();
    res.redirect('/admin');
  } catch (err) {
    console.error('Ошибка POST /admin/deposit/:id:', err);
    res.status(500).send('Ошибка сервера');
  }
});

// =======================
// --- Запуск сервера ---
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} 🚀`));