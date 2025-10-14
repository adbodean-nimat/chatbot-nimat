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
  const palabras = consulta.toLowerCase().split(/\s+/).filter(p => p.length > 2);
  
  let resultados = [];
  
  // Buscar en TODOS los productos
  cat.productos.forEach(prod => {
    let score = 0;
    
    palabras.forEach(palabra => {
      // Buscar en nombre (peso 3)
      if (prod.nombre.toLowerCase().includes(palabra)) score += 3;
      
      // Buscar en keywords (peso 2)
      if (prod.keywords && prod.keywords.some(k => k.includes(palabra))) score += 2;
      
      // Buscar en categoría (peso 2)
      if (prod.categoria_principal.toLowerCase().includes(palabra)) score += 2;
      
      // Buscar en marca (peso 1)
      if (prod.marca && prod.marca.toLowerCase().includes(palabra)) score += 1;
    });
    
    if (score > 0) {
      resultados.push({ ...prod, score });
    }
  });
  
  console.log(`Búsqueda: "${consulta}" - Encontrados: ${resultados.length}`);
  
  return resultados
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
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
      `- ${p.nombre}
  SKU: ${p.sku}
  PRECIO: $${p.precio.toLocaleString('es-AR')}
  STOCK: ${p.stock} unidades disponibles`
    ).join('\n\n')
  : 'No se encontraron productos exactos.';
    
    const completion = await openai.chat.completions.create({
  model: 'gpt-4-turbo-preview',
  messages: [
    {
      role: 'system',
      content: `Sos el asistente de NIMAT, materiales de construcción.

REGLAS CRÍTICAS:
- SIEMPRE mencioná los PRECIOS que te doy
- SIEMPRE mencioná el STOCK disponible
- Usá la información del catálogo
- Tono conversacional argentino.`
    },
    {
      role: 'system',
      content: `CATÁLOGO:\n${contexto}`
    },
    {
      role: 'user',
      content: mensaje
    }
  ],
  temperature: 0.7,
  max_tokens: 500,
  response_format: { type: "text" }
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