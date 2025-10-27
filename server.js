require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const methodOverride = require('method-override');
const User = require('./models/User');

const app = express();

// --- Настройки Express ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static('public'));

// --- Сессии (через MongoDB Atlas) ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    ttl: 24 * 60 * 60 // 1 день
  })
}));

// --- Подключение к MongoDB Atlas ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Atlas connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- Маршруты ---

// 🌟 Регистрация
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

    // Проверка на существующего пользователя
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) return res.render('register', { error: 'Пользователь с таким email уже существует' });

    // Создание пользователя
    const user = new User({
      name,
      email: normalizedEmail,
      age,
      password,
      referredBy: normalizedEmail === adminEmail ? "000001" : referralCode
    });
    await user.save();

    // Создаём сессию
    req.session.userId = user._id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;

    // Редирект в зависимости от роли
    if (normalizedEmail === adminEmail) return res.redirect('/admin');
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'Ошибка регистрации: ' + err.message });
  }
});

// 🔑 Логин
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
      req.session.userId = 'admin';
      req.session.userName = 'Admin';
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
});// 🚪 Выход
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// 🏠 Главная страница
app.get('/', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  if (req.session.userId === 'admin') return res.redirect('/admin');
  const user = await User.findById(req.session.userId);
  res.render('index', { currentUser: user });
});

// 🛠️ Админ-панель
app.get('/admin', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');

  const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
  if (!adminEmail || req.session.userEmail.toLowerCase() !== adminEmail)
    return res.status(403).send('Доступ запрещён');

  const users = await User.find();
  res.render('admin', { users });
});

// 🗑️ Удаление пользователя (только админ)
app.delete('/admin/users/:id', async (req, res) => {
  const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
  if (!req.session.userId || req.session.userEmail.toLowerCase() !== adminEmail)
    return res.status(403).send('Доступ запрещён');

  await User.findByIdAndDelete(req.params.id);
  res.redirect('/admin');
});

// 🚀 Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));