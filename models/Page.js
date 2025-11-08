const mongoose = require('mongoose');

const PageSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true }, // уникальное имя страницы
  html: { type: String, default: '' }, // HTML содержимое
  css: { type: String, default: '' },  // CSS стили
  js: { type: String, default: '' }    // JS код
}, { timestamps: true }); // добавляет createdAt и updatedAt

module.exports = mongoose.model('Page', PageSchema);