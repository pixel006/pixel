require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User'); // путь к твоей модели User

// --- Подключение к MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

async function createFirstUser() {
  try {
    // Проверяем, есть ли уже пользователи
    const userCount = await User.countDocuments();
    if (userCount > 0) {
      console.log('Пользователь уже существует. Скрипт завершён.');
      process.exit();
    }

    // Данные первого пользователя
    const name = "igor";
    const email = "igor@example.com";
    const age = 25;
    const password = "123456"; // можно сменить на любой пароль

    // Хешируем пароль
    const hashedPassword = await bcrypt.hash(password, 10);

    // Генерация простого реферального кода
    const referralCode = "000001";

    const firstUser = new User({
      name,
      email,
      age,
      password: hashedPassword,
      balance: 0,
      totalDeposits: 0,
      referredBy: null,
      referralCode
    });

    await firstUser.save();
    console.log(`✅ Первый пользователь создан! Email: ${email}, Пароль: ${password}, Реферальный код: ${referralCode}`);
    process.exit();
  } catch (err) {
    console.error('Ошибка при создании пользователя:', err);
    process.exit(1);
  }
}

createFirstUser();