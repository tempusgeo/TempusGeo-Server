const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const app = express();

// Middleware
app.use(cors()); // Allow all origins (or restrict to frontend domain)
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Static Files (Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Request Logger (for debugging)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// API Routes
app.use('/api', apiRoutes);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date(), version: config.VERSION });
});

// Root Route (Welcome Message)
app.get('/', (req, res) => {
  res.send('TempusGeo Server is Running! (API Only)');
});

// Fallback for undefined routes
app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
