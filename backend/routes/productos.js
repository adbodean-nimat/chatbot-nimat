// routes/productos.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

let catalogoCache = null;

function cargarCatalogo() {
  if (!catalogoCache) {
    const rutaJson = path.join(__dirname, '../data/productos.json');
    const data = fs.readFileSync(rutaJson, 'utf8');
    catalogoCache = JSON.parse(data);
  }
  return catalogoCache;
}

// Recargar catálogo cada hora
setInterval(() => {
  catalogoCache = null;
  console.log('🔄 Recargando catálogo...');
}, 3600000);

router.get('/productos', (req, res) => {
  try {
    const catalogo = cargarCatalogo();
    
    res.json({
      metadata: catalogo.metadata,
      indices: catalogo.indices,
      productos: catalogo.productos
    });
    
  } catch (error) {
    console.error('Error al cargar catálogo:', error);
    res.status(500).json({ 
      error: 'Error al cargar productos',
      productos: [] 
    });
  }
});

module.exports = router;