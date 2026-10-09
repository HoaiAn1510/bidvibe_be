const express = require('express');
const authService = require('../services/auth_service');

const router = express.Router();

router.post('/register', async (req, res, next) => {
  try {
    const { fullName, email, phone, password, role, shopName } = req.body;
    const result = await authService.register({ fullName, email, phone, password, role, shopName });
    res.status(201).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await authService.login({ email, password });
    res.json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/ops/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await authService.loginOps({ email, password });
    res.json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
