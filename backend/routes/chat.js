const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Cargar catálogo
let catalogo = null;
function cargarCatalogo() {
  if (!catalogo) {
    const data = fs.readFileSync(
      path.join(__dirname, '../data/productos.json'), 
      'utf8'
    );
    catalogo = JSON.parse(data);
  }
  return catalogo;
}

// Buscar productos
function buscarProductos(consulta) {
  const cat = cargarCatalogo();
  const palabras = consulta.toLowerCase().split(' ');
  
  let productosIds = new Set();
  
  // Buscar en índices
  for (const [key, ids] of Object.entries(cat.indices.por_categoria)) {
    if (palabras.some(p => key.toLowerCase().includes(p))) {
      ids.forEach(id => productosIds.add(id));
    }
  }
  
  const productos = Array.from(productosIds)
    .map(id => cat.productos[id])
    .slice(0, 5);
  
  return productos;
}

// Endpoint principal
router.post('/chat', async (req, res) => {
  try {
    const { mensaje } = req.body;
    
    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }
    
    const productos = buscarProductos(mensaje);
    
    const contexto = productos.length > 0
      ? productos.map(p => 
          `- ${p.nombre}\n  Precio: ${p.precio_formateado}\n  Stock: ${p.stock}`
        ).join('\n\n')
      : 'No se encontraron productos exactos.';
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: `Sos el asistente de NIMAT, materiales de construcción.
Sos experto, amable y ayudás a encontrar productos.
SIEMPRE mencioná precio y stock.
Usá tono conversacional argentino.`
        },
        {
          role: 'system',
          content: `PRODUCTOS DISPONIBLES:\n${contexto}`
        },
        {
          role: 'user',
          content: mensaje
        }
      ],
      temperature: 0.7,
      max_tokens: 500
    });
    
    res.json({
      respuesta: completion.choices[0].message.content,
      productos: productos.slice(0, 3)
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al procesar' });
  }
});

module.exports = router;