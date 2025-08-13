const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { TronWeb } = require('tronweb');
const fetch = require('node-fetch');
const { check, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const winston = require('winston');

// Схема для хранения информации о платежах
const PaymentSchema = new mongoose.Schema({
  payeerId: String,
  amount: Number,
  currency: String,
  status: { type: String, default: 'pending' },
  protectionCode: String,
  createdAt: { type: Date, default: Date.now }
});

const Payment = mongoose.model('Payment', PaymentSchema);

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Настройка trust proxy для express-rate-limit
app.set('trust proxy', 1);

// Логирование
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ограничение запросов
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Слишком много запросов, попробуйте позже'
});
app.use(limiter);

// Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 })
  .then(() => logger.info('MongoDB подключён'))
  .catch(err => logger.error('Ошибка MongoDB:', err));

// Схемы MongoDB
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  created_at: { type: Date, default: Date.now },
  referral_code: { type: String, unique: true },
  referred_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

userSchema.pre('save', async function(next) {
  if (!this.referral_code) {
    this.referral_code = crypto.randomBytes(8).toString('hex');
  }
  next();
});

const userProfileSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nickname: { type: String, required: true, unique: true },
  avatar_url: String,
  birth_date: Date,
  gender: String,
  city: String,
  access_type: { type: String, enum: ['trial', 'express', 'full'], default: 'trial' }
});

const friendSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  created_at: { type: Date, default: Date.now }
});

const postSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content_type: { type: String, enum: ['text', 'image', 'video'], required: true },
  content_url: String,
  content_text: String,
  created_at: { type: Date, default: Date.now },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  reposts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

const messageSchema = new mongoose.Schema({
  sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message_text: String,
  created_at: { type: Date, default: Date.now }
});

const userStatsSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lives: { type: Number, default: 3 },
  ban_tokens: { type: Number, default: 5 },
  trial_time_spent: { type: Number, default: 0 },
  is_banned: { type: Boolean, default: false },
  is_moderator: { type: Boolean, default: false },
  points: { type: Number, default: 0 },
  active_time: { type: Number, default: 0 },
  last_active: { type: Date, default: Date.now }
});

const reportSchema = new mongoose.Schema({
  reporter_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reported_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  report_reason: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  created_at: { type: Date, default: Date.now }
});

const banSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  moderator_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  end_date: Date,
  created_at: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['points_purchase', 'subscription_purchase'], required: true },
  amount: Number,
  currency: { type: String, enum: ['USDT'], required: true },
  payment_method: { type: String, enum: ['BESTCHANGE', 'FAUCETPAY'], required: true },
  verification_code: String,
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  transaction_id: String,
  created_at: { type: Date, default: Date.now }
});

const subscriptionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  transaction_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
  end_date: Date,
  status: { type: String, enum: ['active', 'expired'], default: 'active' },
  created_at: { type: Date, default: Date.now }
});

const quizSchema = new mongoose.Schema({
  question: String,
  answers: [String],
  correct_answer: Number,
  created_at: { type: Date, default: Date.now }
});

const adViewSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  viewed_at: { type: Date, default: Date.now }
});

// Модели MongoDB
const User = mongoose.model('User', userSchema);
const UserProfile = mongoose.model('UserProfile', userProfileSchema);
const Friend = mongoose.model('Friend', friendSchema);
const Post = mongoose.model('Post', postSchema);
const Message = mongoose.model('Message', messageSchema);
const UserStats = mongoose.model('UserStats', userStatsSchema);
const Report = mongoose.model('Report', reportSchema);
const Ban = mongoose.model('Ban', banSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);
const Quiz = mongoose.model('Quiz', quizSchema);
const AdView = mongoose.model('AdView', adViewSchema);

// Middleware для проверки JWT и обновления активного времени
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Токен не предоставлен' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    const stats = await UserStats.findOne({ user_id: decoded.id });
    if (stats) {
      if (stats.is_banned) return res.status(403).json({ error: 'Пользователь забанен' });
      if (stats.access_type === 'trial') {
        const timeNow = new Date();
        stats.trial_time_spent += (timeNow - stats.last_active) / 1000 / 60;
        if (stats.trial_time_spent > 30) {
          return res.status(402).json({ error: 'Пробный период истёк. Оплатите или просмотрите рекламу.' });
        }
        stats.last_active = timeNow;
        await stats.save();
      }
    }
    next();
  } catch (err) {
    logger.error('Ошибка проверки токена:', err);
    res.status(401).json({ error: 'Неверный токен' });
  }
};

// Middleware для проверки модератора
const moderatorMiddleware = async (req, res, next) => {
  try {
    const stats = await UserStats.findOne({ user_id: req.user.id });
    if (!stats || !stats.is_moderator) return res.status(403).json({ error: 'Требуются права модератора' });
    next();
  } catch (err) {
    logger.error('Ошибка проверки модератора:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
};

// Инициализация TronWeb
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY }
});

// Генерация уникального кода
const generateVerificationCode = () => crypto.randomBytes(8).toString('hex');

// Валидация
const registerValidation = [
  check('username').notEmpty().withMessage('Имя пользователя обязательно'),
  check('email').isEmail().withMessage('Неверный email'),
  check('password').isLength({ min: 6 }).withMessage('Пароль минимум 6 символов'),
  check('nickname').notEmpty().withMessage('Никнейм обязателен'),
  check('referral_code').optional().isString().withMessage('Неверный реферальный код')
];

const loginValidation = [
  check('email').isEmail().withMessage('Неверный email'),
  check('password').notEmpty().withMessage('Пароль обязателен')
];

const paymentValidation = [
  check('amount').isFloat({ min: 1 }).withMessage('Минимум $1')
];

const reportValidation = [
  check('reported_id').isMongoId().withMessage('Неверный ID'),
  check('report_reason').notEmpty().withMessage('Причина обязательна')
];

const banValidation = [
  check('user_id').isMongoId().withMessage('Неверный ID'),
  check('duration').isInt({ min: 1 }).withMessage('Длительность в днях')
];

const matchValidation = [
  check('gender').optional().isIn(['male', 'female', 'other']).withMessage('Неверный пол'),
  check('age_min').optional().isInt({ min: 18 }).withMessage('Мин возраст >= 18'),
  check('age_max').optional().isInt({ max: 100 }).withMessage('Макс возраст <= 100')
];

const quizAnswerValidation = [
  check('quiz_id').isMongoId().withMessage('Неверный ID викторины'),
  check('answer').isInt().withMessage('Ответ должен быть числом')
];

// Регистрация
app.post('/register', registerValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, email, password, nickname, referral_code } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    let referred_by = null;
    if (referral_code) {
      const referrer = await User.findOne({ referral_code });
      if (referrer) referred_by = referrer._id;
    }
    const user = await User.create({ username, email, password: hashedPassword, referred_by });
    await UserProfile.create({ user_id: user._id, nickname });
    await UserStats.create({ user_id: user._id });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    if (referred_by) {
      const referrerStats = await UserStats.findOne({ user_id: referred_by });
      referrerStats.points += 100;
      await referrerStats.save();
    }
    logger.info(`Пользователь зарегистрирован: ${user._id}`);
    res.status(201).json({ token, userId: user._id });
  } catch (err) {
    logger.error('Ошибка регистрации:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Авторизация
app.post('/login', loginValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверный email или пароль' });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    logger.info(`Пользователь авторизован: ${user._id}`);
    res.json({ token, userId: user._id });
  } catch (err) {
    logger.error('Ошибка авторизации:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Получение профиля
app.get('/api/user/:id', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const profile = await UserProfile.findOne({ user_id: user._id });
    res.json({ user, profile });
  } catch (err) {
    logger.error('Ошибка получения профиля:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Обновление профиля
app.put('/api/profile', authMiddleware, async (req, res) => {
  try {
    const { nickname, birth_date, gender, city, avatar_url } = req.body;
    const userId = req.user.id;
    const profile = await UserProfile.findOneAndUpdate(
      { user_id: userId },
      { nickname, birth_date, gender, city, avatar_url },
      { new: true }
    );
    if (!profile) return res.status(404).json({ error: 'Профиль не найден' });
    logger.info(`Профиль обновлён: ${userId}`);
    res.json(profile);
  } catch (err) {
    logger.error('Ошибка обновления профиля:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Запрос на дружбу
app.post('/friends/request', authMiddleware, async (req, res) => {
  try {
    const { recipientId } = req.body;
    const requesterId = req.user.id;
    if (requesterId === recipientId) return res.status(400).json({ error: 'Нельзя добавить себя' });
    const existing = await Friend.findOne({ requester: requesterId, recipient: recipientId });
    if (existing) return res.status(400).json({ error: 'Запрос уже отправлен' });
    await Friend.create({ requester: requesterId, recipient: recipientId });
    logger.info(`Запрос на дружбу: ${requesterId} -> ${recipientId}`);
    res.status(201).json({ message: 'Запрос отправлен' });
  } catch (err) {
    logger.error('Ошибка запроса на дружбу:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Принятие дружбы
app.post('/friends/accept', authMiddleware, async (req, res) => {
  try {
    const { requestId } = req.body;
    const userId = req.user.id;
    const friendRequest = await Friend.findById(requestId);
    if (!friendRequest || friendRequest.recipient.toString() !== userId) return res.status(403).json({ error: 'Недостаточно прав' });
    friendRequest.status = 'accepted';
    await friendRequest.save();
    logger.info(`Дружба принята: ${requestId}`);
    res.json({ message: 'Запрос принят' });
  } catch (err) {
    logger.error('Ошибка принятия запроса:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Удаление друга
app.post('/friends/delete', authMiddleware, async (req, res) => {
  try {
    const { friendId } = req.body;
    const userId = req.user.id;
    await Friend.deleteOne({
      $or: [
        { requester: userId, recipient: friendId, status: 'accepted' },
        { requester: friendId, recipient: userId, status: 'accepted' }
      ]
    });
    logger.info(`Друг удалён: ${userId} -> ${friendId}`);
    res.json({ message: 'Друг удалён' });
  } catch (err) {
    logger.error('Ошибка удаления друга:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Создание поста
app.post('/posts', authMiddleware, async (req, res) => {
  try {
    const { content_type, content_url, content_text } = req.body;
    const userId = req.user.id;
    const post = await Post.create({ user_id: userId, content_type, content_url, content_text });
    logger.info(`Пост создан: ${post._id}`);
    res.status(201).json(post);
  } catch (err) {
    logger.error('Ошибка создания поста:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Получение ленты
app.get('/news', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const friends = await Friend.find({ $or: [{ requester: userId }, { recipient: userId }], status: 'accepted' });
    const friendIds = friends.map(f => f.requester.toString() === userId ? f.recipient : f.requester);
    friendIds.push(userId);
    const posts = await Post.find({ user_id: { $in: friendIds } }).sort({ created_at: -1 });
    res.json(posts);
  } catch (err) {
    logger.error('Ошибка получения ленты:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Получение друзей
app.get('/friends', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const friends = await Friend.find({ $or: [{ requester: userId }, { recipient: userId }], status: 'accepted' });
    const friendIds = friends.map(f => f.requester.toString() === userId ? f.recipient : f.requester);
    const friendProfiles = await UserProfile.find({ user_id: { $in: friendIds } });
    res.json(friendProfiles);
  } catch (err) {
    logger.error('Ошибка получения друзей:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Получение подписки
app.get('/subscriptions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const subscription = await Subscription.findOne({ user_id: userId, status: 'active', end_date: { $gt: new Date() } }).sort({ end_date: -1 });
    if (!subscription) return res.status(404).json({ error: 'Активная подписка не найдена' });
    res.json(subscription);
  } catch (err) {
    logger.error('Ошибка получения подписки:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Покупка CP через BestChange
app.post('/exchange/initiate', authMiddleware, paymentValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { amount } = req.body;
    const userId = req.user.id;
    const verificationCode = generateVerificationCode();

    const transaction = await Transaction.create({
      user_id: userId,
      type: 'points_purchase',
      amount,
      currency: 'USDT',
      payment_method: 'BESTCHANGE',
      verification_code: verificationCode
    });

    const instructions = `
      1. Перейдите на BestChange.
      2. Выберите способ оплаты (Visa/MasterCard, YooMoney, Qiwi) и USDT TRC-20.
      3. Выберите обменник без KYC.
      4. Отправьте $${amount.toFixed(2)} в USDT на адрес: ${process.env.USDT_WALLET}
      5. Укажите memo: ${verificationCode}
      6. CHOIZZE Points начислятся в течение 10 минут.
      Рекомендуемые обменники:
      - 365Cash: Карты, YooMoney, быстро.
      - BitHunter: Qiwi, SBP, без KYC.
      - WW-Pay: Карты, низкие комиссии.
    `;

    logger.info(`BestChange платёж инициирован: ${transaction._id}`);
    res.json({ message: 'Платеж инициирован', transactionId: transaction._id, instructions });
  } catch (err) {
    logger.error('Ошибка инициирования BestChange:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Фоновая проверка BestChange
async function checkUsdtTransactions() {
  try {
    const response = await fetch(`https://api.trongrid.io/v1/accounts/${process.env.USDT_WALLET}/transactions/trc20`, {
      headers: { 'TRON-PRO-API-KEY': '6a879052-3f4e-4e24-b51f-4fc0de898473' }
    });
    const data = await response.json();

    for (const tx of data.data) {
      if (tx.token_info.symbol !== 'USDT') continue;
      const transaction = await Transaction.findOne({
        verification_code: tx.transaction_id,
        status: 'pending',
        payment_method: 'BESTCHANGE'
      });
      if (transaction) {
        transaction.status = 'completed';
        await transaction.save();
        const userStats = await UserStats.findOne({ user_id: transaction.user_id });
        if (userStats) {
          userStats.points += transaction.amount * 100;
          await userStats.save();
          logger.info(`CP начислены через BestChange: ${transaction.amount * 100} для ${transaction.user_id}`);
        }
      }
    }
  } catch (err) {
    logger.error('Ошибка проверки BestChange:', err);
  }
}

setInterval(checkUsdtTransactions, 60000);

// Покупка CP через FaucetPay
app.post('/faucetpay/initiate', authMiddleware, paymentValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { amount } = req.body;
    const userId = req.user.id;
    const verificationCode = generateVerificationCode();

    const transaction = await Transaction.create({
      user_id: userId,
      type: 'points_purchase',
      amount,
      currency: 'USDT',
      payment_method: 'FAUCETPAY',
      verification_code: verificationCode
    });

    const formData = {
      merchant_username: process.env.FAUCETPAY_USERNAME,
      item_description: `Purchase of ${amount} CHOIZZE Points`,
      amount1: amount.toFixed(2),
      currency1: 'USD',
      currency2: 'USDT',
      custom: verificationCode,
      callback_url: 'http://localhost:3000/faucetpay/callback',
      success_url: 'https://your-frontend.com/success',
      cancel_url: 'https://your-frontend.com/cancel'
    };

    const formHtml = `
      <form id="faucetpayForm" action="https://faucetpay.io/merchant/webscr" method="post">
        <input type="hidden" name="merchant_username" value="${formData.merchant_username}">
        <input type="hidden" name="item_description" value="${formData.item_description}">
        <input type="hidden" name="amount1" value="${formData.amount1}">
        <input type="hidden" name="currency1" value="${formData.currency1}">
        <input type="hidden" name="currency2" value="${formData.currency2}">
        <input type="hidden" name="custom" value="${formData.custom}">
        <input type="hidden" name="callback_url" value="${formData.callback_url}">
        <input type="hidden" name="success_url" value="${formData.success_url}">
        <input type="hidden" name="cancel_url" value="${formData.cancel_url}">
      </form>
      <script>document.getElementById('faucetpayForm').submit();</script>
    `;

    logger.info(`FaucetPay платёж инициирован: ${transaction._id}`);
    res.set('Content-Type', 'text/html');
    res.send(formHtml);
  } catch (err) {
    logger.error('Ошибка инициирования FaucetPay:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// FaucetPay callback
app.post('/faucetpay/callback', async (req, res) => {
  try {
    const { token, merchant_username, amount1, currency1, amount2, currency2, custom } = req.body;
    if (merchant_username !== process.env.FAUCETPAY_USERNAME) {
      logger.warn(`Неверный merchant_username: ${merchant_username}`);
      return res.status(403).json({ error: 'Неверный merchant_username' });
    }

    const response = await fetch(`https://faucetpay.io/merchant/get-payment/${token}`);
    const paymentInfo = await response.json();

    if (!paymentInfo.valid) {
      logger.warn(`Неверный токен: ${token}`);
      return res.status(400).json({ error: 'Неверный токен' });
    }

    if (paymentInfo.currency1 !== 'USD' || paymentInfo.currency2 !== 'USDT') {
      logger.warn(`Неверная валюта: ${paymentInfo.currency1}/${paymentInfo.currency2}`);
      return res.status(400).json({ error: 'Неверная валюта' });
    }

    const transaction = await Transaction.findOne({
      verification_code: custom,
      status: 'pending',
      payment_method: 'FAUCETPAY'
    });

    if (!transaction) {
      logger.warn(`Транзакция не найдена: ${custom}`);
      return res.status(404).json({ error: 'Транзакция не найдена' });
    }

    if (parseFloat(paymentInfo.amount1) !== transaction.amount) {
      logger.warn(`Неверная сумма: ${paymentInfo.amount1} != ${transaction.amount}`);
      return res.status(400).json({ error: 'Неверная сумма' });
    }

    transaction.status = 'completed';
    transaction.transaction_id = paymentInfo.transaction_id;
    await transaction.save();

    const userStats = await UserStats.findOne({ user_id: transaction.user_id });
    if (userStats) {
      userStats.points += transaction.amount * 100;
      await userStats.save();
      logger.info(`CP начислены через FaucetPay: ${transaction.amount * 100} для ${transaction.user_id}`);
    }

    res.status(200).json({ status: 'success' });
  } catch (err) {
    logger.error('Ошибка callback FaucetPay:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Создание репорта
app.post('/reports', authMiddleware, reportValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { reported_id, report_reason } = req.body;
    const reporter_id = req.user.id;
    const userStats = await UserStats.findOne({ user_id: reporter_id });

    if (!userStats || userStats.ban_tokens < 1) return res.status(403).json({ error: 'Недостаточно токенов' });
    userStats.ban_tokens -= 1;
    await userStats.save();

    const report = await Report.create({ reporter_id, reported_id, report_reason });
    logger.info(`Репорт создан: ${report._id}`);
    res.status(201).json({ message: 'Репорт отправлен', reportId: report._id });
  } catch (err) {
    logger.error('Ошибка создания репорта:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Бан пользователя
app.post('/moderator/ban', authMiddleware, moderatorMiddleware, banValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { user_id, duration } = req.body;
    const moderator_id = req.user.id;
    const end_date = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);

    const userStats = await UserStats.findOne({ user_id });
    if (!userStats) return res.status(404).json({ error: 'Пользователь не найден' });

    userStats.is_banned = true;
    userStats.lives -= 1;
    await userStats.save();

    const ban = await Ban.create({ user_id, moderator_id, end_date });
    logger.info(`Бан выдан: ${ban._id}`);
    res.json({ message: 'Пользователь забанен', banId: ban._id });
  } catch (err) {
    logger.error('Ошибка бана:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Матчинг
app.post('/match', authMiddleware, matchValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { gender, age_min, age_max } = req.body;
    const userId = req.user.id;
    const query = {};
    if (gender) query.gender = gender;
    if (age_min || age_max) {
      query.birth_date = {};
      if (age_min) query.birth_date.$lte = new Date(new Date().setFullYear(new Date().getFullYear() - age_min));
      if (age_max) query.birth_date.$gte = new Date(new Date().setFullYear(new Date().getFullYear() - age_max));
    }

    const profiles = await UserProfile.find(query).limit(10);
    const filteredProfiles = profiles.filter(profile => profile.user_id.toString() !== userId);
    res.json(filteredProfiles);
  } catch (err) {
    logger.error('Ошибка матчинга:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Добавление викторины
app.post('/quiz/add', authMiddleware, moderatorMiddleware, async (req, res) => {
  try {
    const { question, answers, correct_answer } = req.body;
    const quiz = await Quiz.create({ question, answers, correct_answer });
    logger.info(`Викторина добавлена: ${quiz._id}`);
    res.status(201).json(quiz);
  } catch (err) {
    logger.error('Ошибка добавления викторины:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Ответ на викторину
app.post('/quiz/answer', authMiddleware, quizAnswerValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { quiz_id, answer } = req.body;
    const userId = req.user.id;
    const quiz = await Quiz.findById(quiz_id);
    if (!quiz) return res.status(404).json({ error: 'Викторина не найдена' });

    if (answer === quiz.correct_answer) {
      const stats = await UserStats.findOne({ user_id: userId });
      stats.points += 200;
      await stats.save();
      logger.info(`Правильный ответ на викторину: ${quiz_id} пользователем ${userId}`);
      res.json({ message: 'Правильный ответ, CP начислены' });
    } else {
      res.json({ message: 'Неправильный ответ' });
    }
  } catch (err) {
    logger.error('Ошибка ответа на викторину:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Просмотр рекламы
app.post('/ad/view', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const stats = await UserStats.findOne({ user_id: userId });
    if (stats.access_type === 'trial') {
      stats.trial_time_spent = 0;
      stats.access_type = 'express';
      await stats.save();
      await AdView.create({ user_id: userId });
      logger.info(`Реклама просмотрена: ${userId}`);
      res.json({ message: 'Реклама просмотрена, экспресс-доступ предоставлен' });
    } else {
      res.status(400).json({ error: 'Экспресс-доступ только для пробного периода' });
    }
  } catch (err) {
    logger.error('Ошибка просмотра рекламы:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Лайк поста
app.post('/posts/:id/like', authMiddleware, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    if (!post.likes.includes(userId)) {
      post.likes.push(userId);
      await post.save();
      const stats = await UserStats.findOne({ user_id: userId });
      stats.points += 1;
      await stats.save();
      logger.info(`Лайк поста: ${postId} пользователем ${userId}`);
      res.json({ message: 'Лайк поставлен, CP начислены' });
    } else {
      res.status(400).json({ error: 'Уже лайкнуто' });
    }
  } catch (err) {
    logger.error('Ошибка лайка:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Репост
app.post('/posts/:id/repost', authMiddleware, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    if (!post.reposts.includes(userId)) {
      post.reposts.push(userId);
      await post.save();
      const stats = await UserStats.findOne({ user_id: userId });
      stats.points += 2;
      await stats.save();
      logger.info(`Репост: ${postId} пользователем ${userId}`);
      res.json({ message: 'Репост сделан, CP начислены' });
    } else {
      res.status(400).json({ error: 'Уже репостнуто' });
    }
  } catch (err) {
    logger.error('Ошибка репоста:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// Получение статистики пользователя
app.get('/api/stats/:userId', authMiddleware, async (req, res) => {
  try {
    const userId = req.params.userId;
    const stats = await UserStats.findOne({ user_id: userId });
    if (!stats) return res.status(404).json({ error: 'Статистика не найдена' });
    res.json(stats);
  } catch (err) {
    logger.error('Ошибка получения статистики:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
  }
});

// WebSocket чат
io.on('connection', (socket) => {
  logger.info(`Пользователь подключён: ${socket.id}`);
  socket.on('join', (data) => {
    socket.join(data.userId);
    logger.info(`Пользователь ${data.userId} присоединился`);
  });
  socket.on('message', async (msg) => {
    logger.info(`Сообщение: ${JSON.stringify(msg)}`);
    const message = {
      sender_id: msg.senderId,
      receiver_id: msg.receiverId,
      message_text: msg.content,
      created_at: new Date()
    };
    try {
      const savedMessage = await Message.create(message);
      io.to(msg.receiverId).emit('message', savedMessage);
      logger.info(`Сообщение отправлено: ${savedMessage._id}`);
    } catch (err) {
      logger.error('Ошибка сохранения сообщения:', err);
    }
  });
  socket.on('disconnect', () => {
    logger.info(`Пользователь отключён: ${socket.id}`);
  });
});

// Тестовый маршрут
app.get('/', (req, res) => res.send('CHOIZZE Backend API'));

// Обработчик вебхука от PAYEER
app.post('/payeer_webhook', async (req, res) => {
  const { m_orderid, m_amount, m_curr, m_desc } = req.body;

  // Проверяем, что платеж прошел успешно
  if (req.body.m_status === 'success') {
    const payment = new Payment({
      payeerId: m_orderid,
      amount: m_amount,
      currency: m_curr,
      protectionCode: m_desc
    });
    
    await payment.save();

    console.log(`[PAYEER Webhook] Received payment for order: ${m_orderid}. Launching check script.`);

    // Запускаем скрипт puppeteer в отдельном процессе
    const puppeteerProcess = spawn('node', ['check_payeer.js', m_orderid]);

    puppeteerProcess.stdout.on('data', (data) => {
      console.log(`[PAYEER Check Script] stdout: ${data}`);
    });
    
    puppeteerProcess.stderr.on('data', (data) => {
      console.error(`[PAYEER Check Script] stderr: ${data}`);
    });
    
    puppeteerProcess.on('close', (code) => {
      console.log(`[PAYEER Check Script] exited with code ${code}`);
      // Здесь можно добавить логику, что делать после проверки
    });

    res.status(200).send('OK');
  } else {
    console.error(`[PAYEER Webhook] Received unsuccessful status for order: ${m_orderid}`);
    res.status(400).send('Bad Request');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`Сервер запущен на http://localhost:${PORT}`));