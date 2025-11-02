const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  age: { type: Number, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },

  // Уникальный код пользователя
  referralCode: { 
    type: String, 
    unique: true, 
    default: () => crypto.randomBytes(3).toString('hex').toUpperCase() // пример: "A1B2C3"
  },

  // Код того, кто пригласил — необязателен для первого пользователя или админа
  referredBy: { 
    type: String, 
    required: function() {
      // Если пользователь админ или первый в базе — не обязателен
      return !this.isAdmin && !this.isFirstUser;
    },
    default: null
  },

  // Финансы
  balance: { type: Number, default: 0 },
  deposits: { type: Number, default: 0 } // сколько пополнил
}, { timestamps: true });

// Виртуальные поля для проверки первого пользователя и админа
userSchema.virtual('isAdmin').get(function() {
  return this.email === process.env.ADMIN_EMAIL;
});

userSchema.virtual('isFirstUser').get(async function() {
  const User = mongoose.model('User');
  const count = await User.countDocuments();
  return count === 0;
});

// Хеширование пароля перед сохранением
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Проверка пароля
userSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password || !candidatePassword) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);