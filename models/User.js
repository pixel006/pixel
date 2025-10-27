const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    age: { type: Number, required: true },               // возраст обязателен
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    referralCode: { type: String, unique: true },        // уникальный код пользователя
    referredBy: { type: String, required: true },       // обязательный код того, кто пригласил
    balance: { type: Number, default: 0 }               // баланс по умолчанию 0
}, { timestamps: true });

// Генерация уникального реферального кода и хеширование пароля перед сохранением
userSchema.pre('save', async function(next) {
    // Генерация реферального кода, если его ещё нет
    if (!this.referralCode) {
        this.referralCode = crypto.randomBytes(3).toString('hex'); // 6 символов
    }

    // Хеширование пароля
    if (!this.isModified('password')) return next();
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

// Метод для проверки пароля
userSchema.methods.comparePassword = async function(candidatePassword) {
    if (!this.password || !candidatePassword) return false;
    return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);