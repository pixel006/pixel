require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const methodOverride = require('method-override');
const cron = require('node-cron');
const bcrypt = require('bcrypt');
const User = require('./models/User');
const Deposit = require('./models/Deposit');

const app = express();

// =======================
// --- Настройки EJS и статики ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static('public'));

// =======================
// --- Сессии ---
app.use(session({
    secret: 'supersecretkey',
    resave: false,
    saveUninitialized: false
}));

// =======================
// --- Подключение к MongoDB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected ✅'))
    .catch(err => console.log('MongoDB connection error:', err));

// =======================
// --- Функция начисления процентов ---
async function accrueDailyInterest() {
    try {
        const deposits = await Deposit.find({ status: 'active' });
        const today = new Date();

        // --- Ставка из .env или по умолчанию 4.5% ---
        const DAILY_RATE = parseFloat(process.env.DAILY_RATE) || 0.045;

        for (let dep of deposits) {
            const user = await User.findById(dep.userId);
            if (!user) continue;

            const days = Math.floor((today - dep.lastInterestDate) / (1000 * 60 * 60 * 24));
            if (days > 0 && dep.remainingDays > 0) {
                const interest = dep.principal * DAILY_RATE;
                dep.accrued += interest;
                dep.remainingDays -= 1;
                dep.lastInterestDate = today;

                user.balance += interest;
                if (!user.transactions) user.transactions = [];
                user.transactions.push({
                    type: 'interest',
                    amount: interest,
                    description: `Ежедневное начисление ${interest.toFixed(2)}$`,
                    date: today,
                    status: 'completed'
                });

                if (dep.remainingDays <= 0) dep.status = 'completed';

                await dep.save();
                await user.save();
            }
        }
    } catch (err) {
        console.error('Ошибка начисления процентов:', err);
    }
}

// Запуск начисления ежедневно в 03:00
cron.schedule('* * * * *', accrueDailyInterest);

// =======================
// --- Регистрация ---
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
    try {
        const { name, email, age, password, referralCode } = req.body;
        if (!email) return res.render('register', { error: 'Email обязателен' });
        if (!password) return res.render('register', { error: 'Пароль обязателен' });
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

// =======================
// --- Логин ---
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.render('login', { error: 'Email и пароль обязательны' });

        const normalizedEmail = email.toLowerCase();
        const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
        const adminPassword = process.env.ADMIN_PASSWORD ?? null;

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

// =======================
// --- Страница депозита ---
app.get('/deposit', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        const user = await User.findById(req.session.userId);

        const lastDeposit = await Deposit.findOne({ userId: user._id }).sort({ createdAt: -1 });
        const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
        const sessionEmail = req.session.userEmail ? req.session.userEmail.toLowerCase() : null;
        let canDeposit = true;

        if (sessionEmail !== adminEmail && lastDeposit) {
            const daysSinceLast = (new Date() - lastDeposit.createdAt) / (1000 * 60 * 60 * 24);
            canDeposit = daysSinceLast >= 30;
        }

        res.render('deposit', { currentUser: user, error: null, canDeposit });
    } catch (err) {
        console.error('Ошибка GET /deposit:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// =======================
// --- POST /start-deposit ---
app.post('/start-deposit', async (req, res) => {
    try {
        if (!req.session.userId)
            return res.status(401).json({ success: false, message: 'Не авторизован' });

        const { amount } = req.body;
        const numericAmount = parseFloat(amount);

        if (!numericAmount || numericAmount <= 0)
            return res.json({ success: false, message: 'Введите корректную сумму' });

        if (numericAmount < 50)
            return res.json({ success: false, message: 'Минимальная сумма депозита — 50$' });

        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

        if (numericAmount > user.balance)
            return res.json({ success: false, message: 'Недостаточно средств' });

        const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
        const sessionEmail = req.session.userEmail ? req.session.userEmail.toLowerCase() : null;

        if (sessionEmail !== adminEmail) {
            const lastDeposit = await Deposit.findOne({ userId: user._id }).sort({ createdAt: -1 });
            if (lastDeposit) {
                const daysSinceLast = (new Date() - lastDeposit.createdAt) / (1000 * 60 * 60 * 24);
                if (daysSinceLast < 30) {
                    return res.json({
                        success: false,
                        message: `Вы уже запускали депозит ${Math.floor(daysSinceLast)} дней назад. Новый можно будет через ${Math.ceil(30 - daysSinceLast)} дней.`
                    });
                }
            }
        }

        user.balance -= numericAmount;

        const deposit = new Deposit({
            userId: user._id,
            principal: numericAmount,
            accrued: 0,
            status: 'active',
            remainingDays: 30,
            lastInterestDate: new Date(),
            createdAt: new Date()
        });

        const DAILY_RATE = parseFloat(process.env.DAILY_RATE) || 0.045;
        const firstInterest = numericAmount * DAILY_RATE;
        deposit.accrued += firstInterest;
        user.balance += firstInterest;

        if (!user.transactions) user.transactions = [];
        user.transactions.push({
            type: 'deposit',
            amount: numericAmount,
            description: `Запущен депозит на $${numericAmount}`,
            date: new Date(),
            status: 'active'
        });
        user.transactions.push({
            type: 'interest',
            amount: firstInterest,
            description: `Начислено ${firstInterest.toFixed(2)}$ при запуске депозита`,
            date: new Date(),
            status: 'completed'
        });

        // Реферальный бонус
        let referralBonus = 0;
        if (user.referredBy) {
            const referrer = await User.findOne({ referralCode: user.referredBy });
            if (referrer) {
                referralBonus = numericAmount * 0.15;
                referrer.balance += referralBonus;

                if (!referrer.transactions) referrer.transactions = [];
                referrer.transactions.push({
                    type: 'referral_bonus',
                    amount: referralBonus,
                    description: `Бонус 15% от депозита реферала ${user.name}`,
                    date: new Date(),
                    status: 'completed'
                });

                await referrer.save();
            }
        }

        await deposit.save();
        await user.save();

        res.json({
            success: true,
            message: `Депозит на $${numericAmount} запущен! Начислено ${firstInterest.toFixed(2)}$`,
            newBalance: user.balance,
            referralBonus
        });

    } catch (err) {
        console.error('Ошибка POST /start-deposit:', err);
        res.status(500).json({ success: false, message: 'Ошибка при запуске депозита, попробуйте позже' });
    }
});

// =======================
// --- Админка ---
app.get('/admin', async (req, res) => {
    try {
        const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
        const sessionEmail = req.session.userEmail ? req.session.userEmail.toLowerCase() : null;
        if (!req.session.userId || sessionEmail !== adminEmail) {
            return res.status(403).send('Доступ запрещён');
        }

        const users = await User.find();
        res.render('admin', { users });
    } catch (err) {
        console.error('Ошибка GET /admin:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// =======================
// --- Пополнение и вывод админом ---
app.post('/admin/deposit/:id', async (req, res) => {
    try {
        const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
        const sessionEmail = req.session.userEmail ? req.session.userEmail.toLowerCase() : null;
        if (!req.session.userId || sessionEmail !== adminEmail) {
            return res.status(403).json({ success: false, message: 'Доступ запрещён' });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

        const amount = parseFloat(req.body.amount);
        if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Некорректная сумма' });

        user.balance += amount;
        if (!user.transactions) user.transactions = [];
        user.transactions.push({
            type: 'deposit',
            amount,
            description: 'Пополнение админом',
            date: new Date(),
            status: 'completed'
        });

        await user.save();
        res.json({ success: true, message: `Баланс пополнен на ${amount}$` });
    } catch (err) {
        console.error('Ошибка /admin/deposit:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера при пополнении' });
    }
});

app.post('/admin/withdraw/:id', async (req, res) => {
    try {
        const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
        const sessionEmail = req.session.userEmail ? req.session.userEmail.toLowerCase() : null;
        if (!req.session.userId || sessionEmail !== adminEmail) {
            return res.status(403).json({ success: false, message: 'Доступ запрещён' });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

        const amount = parseFloat(req.body.amount);
        if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Некорректная сумма' });
        if (user.balance < amount) return res.status(400).json({ success: false, message: 'Недостаточно средств' });

        user.balance -= amount;
        if (!user.transactions) user.transactions = [];
        user.transactions.push({
            type: 'withdraw',
            amount,
            description: 'Вывод админом',
            date: new Date(),
            status: 'completed'
        });

        await user.save();
        res.json({ success: true, message: `Выведено ${amount}$` });
    } catch (err) {
        console.error('Ошибка /admin/withdraw:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера при выводе' });
    }
});

// =======================
// --- Удаление пользователя ---
app.delete('/admin/users/:id', async (req, res) => {
    try {
        const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
        const sessionEmail = req.session.userEmail ? req.session.userEmail.toLowerCase() : null;
        if (!req.session.userId || sessionEmail !== adminEmail) {
            return res.status(403).json({ success: false, message: 'Доступ запрещён' });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

        await user.deleteOne();
        res.json({ success: true, message: 'Пользователь удалён' });
    } catch (err) {
        console.error('Ошибка DELETE /admin/users/:id:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// =======================
// --- Logout ---
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Ошибка при выходе:', err);
            return res.status(500).send('Ошибка сервера');
        }
        res.redirect('/login');
    });
});

// =======================
// --- История депозитов ---
app.get('/history', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        if (req.session.userId === "admin") return res.redirect('/admin');

        const user = await User.findById(req.session.userId);
        if (!user) return res.redirect('/login');

        const deposits = await Deposit.find({ userId: user._id }).sort({ createdAt: -1 });
        const enrichedDeposits = deposits.map(dep => ({ ...dep.toObject(), daysLeft: dep.remainingDays }));

        res.render('history', {
            currentUser: user,
            deposits: enrichedDeposits,
            transactions: user.transactions || []
        });
    } catch (err) {
        console.error('Ошибка GET /history:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// =======================
// --- Группа (рефералы) ---
app.get('/group', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        if (req.session.userId === "admin") return res.redirect('/admin');

        const user = await User.findById(req.session.userId);
        if (!user) return res.redirect('/login');

        const referrals = await User.find({ referredBy: user.referralCode });

        res.render('group', {
            currentUser: user,
            team: referrals || [],
            request: req
        });
    } catch (err) {
        console.error('Ошибка GET /group:', err);
        res.status(500).send('Внутренняя ошибка сервера');
    }
});

// =======================
// --- Настройки пароля ---
app.get('/settings', async (req, res) => {
    if (!req.session.userId || req.session.userId === "admin") return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    res.render('settings', { currentUser: user, error: null, success: null });
});

app.post('/settings', async (req, res) => {
    try {
        const { oldPassword, newPassword, confirmPassword } = req.body;
        const user = await User.findById(req.session.userId);

        if (newPassword !== confirmPassword) {
            return res.render('settings', { currentUser: user, error: 'Пароли не совпадают', success: null });
        }

        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) return res.render('settings', { currentUser: user, error: 'Старый пароль неверный', success: null });

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.render('settings', { currentUser: user, error: null, success: 'Пароль успешно изменён!' });
    } catch (err) {
        console.error('Ошибка POST /settings:', err);
        res.render('settings', { currentUser: req.user, error: 'Ошибка сервера', success: null });
    }
});

// =======================
// --- Запуск сервера ---
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} 🚀`));
