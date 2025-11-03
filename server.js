require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const methodOverride = require('method-override');
const User = require('./models/User');

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

// --- Регистрация пользователя ---
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
    try {
        const { name, email, age, password, referralCode } = req.body;
        if (!email) return res.render('register', { error: 'Email обязателен' });
        if (age < 18) return res.render('register', { error: 'Регистрация только с 18 лет и старше' });

        const normalizedEmail = email.toLowerCase();
        const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;

        // Проверка реферального кода для обычных пользователей
        if (adminEmail && normalizedEmail !== adminEmail) {
            if (!referralCode) return res.render('register', { error: 'Реферальный код обязателен' });
            const refUser = await User.findOne({ referralCode });
            if (!refUser) return res.render('register', { error: 'Некорректный реферальный код' });
        }

        // Проверка уникальности email
        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) return res.render('register', { error: 'Пользователь с таким email уже зарегистрирован' });

        // Создание пользователя с начальным балансом и пустой историей операций
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

        // Сессия
        req.session.userId = user._id;
        req.session.userName = user.name;
        req.session.userEmail = user.email;

        if (normalizedEmail === adminEmail) return res.redirect('/admin');
        res.redirect('/');
    } catch (err) {
        res.render('register', { error: 'Ошибка регистрации: ' + err.message });
    }
});

// --- Логин ---
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email) return res.render('login', { error: 'Email обязателен' });
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
        if (!isMatch) return res.render('login', { error: 'Неверный email или пароль' });req.session.userId = user._id;
        req.session.userName = user.name;
        req.session.userEmail = user.email;
        res.render('index', { currentUser: user });
    } catch (err) {
        res.render('login', { error: 'Ошибка входа: ' + err.message });
    }
});

// --- Главная страница ---
app.get('/', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.userId === "admin") return res.redirect('/admin');

    const user = await User.findById(req.session.userId);
    if (!user) return res.redirect('/login');

    res.render('index', { currentUser: user });
});

// --- Страница группы ---
app.get('/group', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.userId === "admin") return res.redirect('/admin');

    const currentUser = await User.findById(req.session.userId);
    if (!currentUser) return res.redirect('/login');

    const team = await User.find({ referredBy: currentUser.referralCode });

    res.render('group', { currentUser, team, request: req });
});

// --- Пополнение баланса ---
app.get('/deposit', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    res.render('deposit', { currentUser: user });
});

app.post('/deposit', async (req, res) => {
    const { amount, method } = req.body;
    const user = await User.findById(req.session.userId);

    const tx = {
        type: 'deposit',
        amount: parseFloat(amount),
        currency: 'USDT',
        date: new Date(),
        source: method,
        status: 'pending'
    };

    user.transactions.push(tx);
    await user.save();

    // Генерация ссылки на оплату
    let paymentUrl = '#';
    switch(method) {
        case 'metamask': paymentUrl =`/pay/metamask/${tx.amount}`; break;
        case 'walletconnect': paymentUrl = `/pay/walletconnect/${tx.amount}`; break;
        case 'koshelekru': paymentUrl = `/pay/koshelekru/${tx.amount}`; break;
        case 'bybit': paymentUrl = `/pay/bybit/${tx.amount}`; break;
    }

    res.json({ success: true, paymentUrl });
});

// --- Симуляция оплаты ---
app.get('/pay/:method/:amount', async (req, res) => {
    const { method, amount } = req.params;
    const user = await User.findById(req.session.userId);

    const tx = user.transactions.reverse().find(t => t.amount === parseFloat(amount) && t.status === 'pending');
    if (tx) {
        tx.status = 'completed';
        user.balance += parseFloat(amount);
        await user.save();
    }

    res.send(`<h2>Пополнение через ${method} на ${amount}$ прошло успешно!</h2>
              <a href="/">Вернуться на главную</a>`);
});

// --- История операций ---
app.get('/history', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.userId === "admin") return res.redirect('/admin');

    const currentUser = await User.findById(req.session.userId);
    if (!currentUser) return res.redirect('/login');

    const transactions = currentUser.transactions || [];
    res.render('history', { currentUser, transactions });
});

// --- Выход ---
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// --- Админ-панель ---
app.get('/admin', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
    if (!adminEmail || req.session.userEmail.toLowerCase() !== adminEmail)
        return res.status(403).send('Доступ запрещён');

    const users = await User.find();
    res.render('admin', { users });
});

// --- Удаление пользователя ---
app.delete('/admin/users/:id', async (req, res) => {
    const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
    if (!req.session.userId || req.session.userEmail.toLowerCase() !== adminEmail)
        return res.status(403).send('Доступ запрещён');await User.findByIdAndDelete(req.params.id);
    res.redirect('/admin');
});

// --- Запуск сервера ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} 🚀`));