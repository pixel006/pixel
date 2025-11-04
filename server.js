require('dotenv').config();
import express from "express";
import fs from "fs-extra";
import cron from "node-cron";
import path from "path";
import mongoose from "mongoose";
import session from "express-session";
import methodOverride from "method-override";
import User from './models/User';
import Deposit from './models/Deposit';

const app = express();
const __dirname = process.cwd();
const dataFile = path.join(__dirname, "deposits.json");

// --- Настройки EJS и статики ---
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

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
// --- JSON-депозиты: загрузка и сохранение ---
// =======================
async function loadDeposits() {
    try {
        return await fs.readJson(dataFile);
    } catch {
        return [];
    }
}

async function saveDeposits(deposits) {
    await fs.writeJson(dataFile, deposits, { spaces: 2 });
}

// =======================
// --- Ежедневное начисление процентов по JSON-депозитам ---
// =======================
cron.schedule("0 3 * * *", async () => {
    console.log("Начисляем проценты (JSON)...");

    const deposits = await loadDeposits();
    let count = 0;

    for (const dep of deposits) {
        if (dep.status === "active") {
            const profit = dep.principal * 0.04; // 4% в день
            dep.accrued += profit;
            dep.lastAccrual = new Date();
            count++;
        }
    }

    await saveDeposits(deposits);
    console.log(`Начислены проценты по ${count} JSON-депозитам`);
});

// =======================
// --- MongoDB-депозиты: функция начисления процентов ---
// =======================
async function accrueDailyInterest(userId) {
    try {
        const deposits = await Deposit.find({ userId, status: 'active' });
        const today = new Date();

        for (let dep of deposits) {
            const days = Math.floor((today - dep.lastInterestDate) / (1000*60*60*24));
            if (days > 0) {
                const interest = dep.principal * 0.04 * days; // 4% в день
                dep.accrued += interest;
                dep.lastInterestDate = today;
                await dep.save();

                const user = await User.findById(userId);
                if (!user.transactions) user.transactions = [];
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
    } catch (err) {
        console.error('Ошибка начисления процентов (MongoDB):', err);
    }
}

// =======================
// --- JSON-депозиты: маршруты ---
// =======================
app.get("/", async (req, res) => {
    const deposits = await loadDeposits();
    res.render("history", { deposits, transactions: [] });
});

app.get("/add", async (req, res) => {
    const deposits = await loadDeposits();
    deposits.push({
        id: Date.now(),
        principal: 1000,
        accrued: 0,
        rate: 0.04, // 4% в день
        status: "active",
        lastAccrual: new Date()
    });
    await saveDeposits(deposits);
    res.send("✅ Депозит добавлен!");
});

// =======================
// --- MongoDB-депозиты и остальной функционал ---
// =======================

// Регистрацияapp.get('/register', (req, res) => res.render('register', { error: null }));
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

// Логин
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

// Главная
app.get('/', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        if (req.session.userId === "admin") return res.redirect('/admin');

        const user = await User.findById(req.session.userId);
        if (!user) return res.redirect('/login');

        res.render('index', { currentUser: user });
    } catch (err) {
        console.error('Ошибка GET /:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Страница группы
app.get('/group', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        if (req.session.userId === "admin") return res.redirect('/admin');

        const currentUser = await User.findById(req.session.userId);
        if (!currentUser) return res.redirect('/login');const team = await User.find({ referredBy: currentUser.referralCode });
        res.render('group', { currentUser, team, request: req });
    } catch (err) {
        console.error('Ошибка GET /group:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Депозит
app.get('/deposit', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        const user = await User.findById(req.session.userId);
        if (!user) return res.redirect('/login');
        res.render('deposit', { currentUser: user, error: null });
    } catch (err) {
        console.error('Ошибка GET /deposit:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/start-deposit', async (req, res) => {
    try {
        if (!req.session.userId) return res.status(401).send('Не авторизован');

        const { amount } = req.body;
        const numericAmount = parseFloat(amount);
        if (!numericAmount || numericAmount <= 0) return res.status(400).send('Введите корректную сумму');

        const deposit = new Deposit({
            userId: req.session.userId,
            principal: numericAmount,
            accrued: 0,
            status: 'active',
            lastInterestDate: new Date()
        });
        await deposit.save();

        const user = await User.findById(req.session.userId);
        if (!user.transactions) user.transactions = [];
        user.transactions.push({
            type: 'deposit',
            amount: numericAmount,
            description: `В работе ${numericAmount}$`,
            date: new Date(),
            status: 'active'
        });

        if (user.referredBy) {
            const referrer = await User.findOne({ referralCode: user.referredBy });
            if (referrer) {
                if (!referrer.transactions) referrer.transactions = [];
                const reward = numericAmount * 0.10;
                referrer.balance += reward;
                referrer.transactions.push({
                    type: 'referral',
                    amount: reward,
                    description: `Реферальное вознаграждение за депозит ${user.name}`,
                    date: new Date(),
                    status: 'completed'
                });
                await referrer.save();
            }
        }

        await user.save();
        res.redirect('/history');
    } catch (err) {
        console.error('Ошибка POST /start-deposit:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// История
app.get('/history', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        if (req.session.userId === "admin") return res.redirect('/admin');

        const currentUser = await User.findById(req.session.userId);
        if (!currentUser) return res.redirect('/login');

        await accrueDailyInterest(req.session.userId);
        const deposits = await Deposit.find({ userId: currentUser._id });
        const transactions = currentUser.transactions || [];

        res.render('history', { currentUser, deposits, transactions });
    } catch (err) {
        console.error('Ошибка GET /history:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Остальной функционал: вывод средств, админ, logout остаётся без изменений

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} 🚀`));