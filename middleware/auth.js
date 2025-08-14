const jwt = require('jsonwebtoken');

// Секретный ключ для подписи JWT. Он должен совпадать с тем, что в server.js
const jwtSecret = 'ваш_супер_секретный_ключ_для_jwt';

const auth = (req, res, next) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Авторизация не пройдена, нет токена.' });
    }

    const decodedToken = jwt.verify(token, jwtSecret);
    req.user = decodedToken;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Авторизация не пройдена, неверный токен.' });
  }
};

module.exports = auth;