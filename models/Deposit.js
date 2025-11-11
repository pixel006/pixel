const mongoose = require('mongoose');

const depositSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // ссылка на пользователя
  principal: { type: Number, required: true },            // изначальная сумма депозита
  accrued: { type: Number, default: 0 },                 // накопленные проценты
  status: { type: String, enum: ['active', 'completed'], default: 'active' }, // статус депозита
  remainingDays: { type: Number, default: 30 },          // сколько дней осталось до завершения
  lastInterestDate: { type: Date, default: Date.now },   // дата последнего начисления процентов
  startDate: { type: Date, default: Date.now },          // дата запуска депозита
  createdAt: { type: Date, default: Date.now }           // дата создания записи в БД
});

module.exports = mongoose.model('Deposit', depositSchema);
