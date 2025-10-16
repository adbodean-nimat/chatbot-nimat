const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Importar y usar rutas
const chatRouter = require('./routes/chat');
app.use('/api', chatRouter);

const productosRoutes = require('./routes/productos');
app.use('/api', productosRoutes);

const empresaRoutes = require('./routes/empresa');
app.use('/api', empresaRoutes);

app.listen(PORT, () => {
  console.log('Servidor en puerto', PORT);
});