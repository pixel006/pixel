require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const methodOverride = require('method-override');
const User = require('./models/User');
const Deposit = require('./models/Deposit');

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
async function accrueDailyInterest(userId) {
    const deposits = await Deposit.find({ userId, status: 'active' });
    const today = new Date();

    for (let dep of deposits) {
        const days = Math.floor((today - dep.lastInterestDate) / (1000*60*60*24));
        if (days > 0) {
            const interest = dep.principal * 0.035 * days; // 3.5% в день
            dep.accrued += interest;
            dep.lastInterestDate = today;
            await dep.save();

            // Обновляем историю пользователя
            const user = await User.findById(userId);
            user.transactions.push({
                type: 'interest',
                amount: interest,
                description: `Начислено ${interest.toFixed(2)}$`,
                date: today,
                status: 'completed'
            });
            await user.save();
        }
    }
}

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

        const user = new User({
            name,
            email: normalizedEmail,
            age,
            password,
            referredBy: normalizedEmail === adminEmail ? "000001" : referralCode,
            balance: 0,
            transactions: []
        });
        await user.save();

        req.session.userId = user._id;
        req.session.userName = user.name;
        req.session.userEmail = user.email;

        if (normalizedEmail === adminEmail) return res.redirect('/admin');
        res.redirect('/');
    } catch (err) {
        res.render('register', { error: 'Ошибка регистрации: ' + err.message });
    }
});

// =======================
// --- Логин ---
// =======================
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;if (!email) return res.render('login', { error: 'Email обязателен' });
        const normalizedEmail = email.toLowerCase();
        const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
        const adminPassword = process.env.ADMIN_PASSWORD || null;

        // Логин админа
        if (normalizedEmail === adminEmail && password === adminPassword) {
            req.session.userId = "admin";
            req.session.userName = "Admin";
            req.session.userEmail = adminEmail;
            return res.redirect('/admin');
        }

        // Логин обычного пользователя
        const user = await User.findOne({ email: normalizedEmail });
        if (!user) return res.render('login', { error: 'Неверный email или пароль' });

        const isMatch = await user.comparePassword(password);
        if (!isMatch) return res.render('login', { error: 'Неверный email или пароль' });

        req.session.userId = user._id;
        req.session.userName = user.name;
        req.session.userEmail = user.email;
        res.redirect('/');
    } catch (err) {
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
// --- Страница группы ---
// =======================
app.get('/group', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.userId === "admin") return res.redirect('/admin');

    const currentUser = await User.findById(req.session.userId);
    if (!currentUser) return res.redirect('/login');

    const team = await User.find({ referredBy: currentUser.referralCode });

    res.render('group', { currentUser, team, request: req });
});

// =======================
// --- Запуск депозита ---
// =======================
app.get('/deposit', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    if (!user) return res.redirect('/login');
    res.render('deposit', { currentUser: user, error: null });
});

app.post('/start-deposit', async (req, res) => {
    if (!req.session.userId) return res.status(401).send('Не авторизован');

    const { amount } = req.body;
    const numericAmount = parseFloat(amount);

    if (!numericAmount || numericAmount <= 0) {
        return res.status(400).send('Введите корректную сумму');
    }

    // Создаём депозит
    const deposit = new Deposit({
        userId: req.session.userId,
        principal: numericAmount,
        accrued: 0,
        status: 'active',
        lastInterestDate: new Date()
    });
    await deposit.save();

    // Добавляем запись в историю пользователя
    const user = await User.findById(req.session.userId);
    user.transactions.push({
        type: 'deposit',
        amount: numericAmount,
        description: `В работе ${numericAmount}$`,
        date: new Date(),
        status: 'active'
    });
    await user.save();

    res.redirect('/history');
});

// =======================
// --- История операций ---
// =======================
app.get('/history', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.userId === "admin") return res.redirect('/admin');

    const currentUser = await User.findById(req.session.userId);
    if (!currentUser) return res.redirect('/login');

    await accrueDailyInterest(req.session.userId);

    const deposits = await Deposit.find({ userId: currentUser._id });
    const transactions = currentUser.transactions || [];

    res.render('history', { currentUser, deposits, transactions });
});// =======================
// --- Вывод средств ---
// =======================
app.get('/withdraw', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.userId === "admin") return res.redirect('/admin');

    const user = await User.findById(req.session.userId);
    res.render('withdraw', { currentUser: user, error: null });
});

app.post('/withdraw', async (req, res) => {
    if (!req.session.userId) return res.status(401).send('Не авторизован');

    const user = await User.findById(req.session.userId);
    const { amount, cryptoAddress } = req.body;

    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount <= 0) {
        return res.render('withdraw', { currentUser: user, error: 'Введите корректную сумму' });
    }

    if (numericAmount > user.balance) {
        return res.render('withdraw', { currentUser: user, error: 'Сумма превышает баланс аккаунта' });
    }

    const fee = numericAmount * 0.02;
    const totalDeduction = numericAmount + fee;

    const tx = {
        type: 'withdraw',
        amount: numericAmount,
        fee,
        currency: 'USDT',
        date: new Date(),
        destination: cryptoAddress,
        status: 'pending'
    };

    user.transactions.push(tx);
    user.balance -= totalDeduction;
    await user.save();

    res.render('withdraw', { currentUser: user, tx });
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
    if (!req.session.userId) return res.redirect('/login');

    const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
    if (!adminEmail || req.session.userEmail.toLowerCase() !== adminEmail)
        return res.status(403).send('Доступ запрещён');

    const users = await User.find();
    res.render('admin', { users });
});

app.delete('/admin/users/:id', async (req, res) => {
    const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
    if (!req.session.userId || req.session.userEmail.toLowerCase() !== adminEmail)
        return res.status(403).send('Доступ запрещён');

    await User.findByIdAndDelete(req.params.id);
    res.redirect('/admin');
});

// =======================
// --- Запуск сервера ---
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} 🚀`));