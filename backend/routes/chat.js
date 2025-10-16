// routes/chat.js
const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Cache de datos
let catalogoCache = null;
let datosEmpresaCache = null;

// ============================================
// FUNCIONES DE CARGA DE DATOS
// ============================================

function cargarCatalogo() {
  if (!catalogoCache) {
    const rutaJson = path.join(__dirname, '../data/productos.json');
    const data = fs.readFileSync(rutaJson, 'utf8');
    catalogoCache = JSON.parse(data);
  }
  return catalogoCache;
}

function cargarDatosEmpresa() {
  if (!datosEmpresaCache) {
    const rutaJson = path.join(__dirname, '../data/datos.json');
    const data = fs.readFileSync(rutaJson, 'utf8');
    datosEmpresaCache = JSON.parse(data);
  }
  return datosEmpresaCache;
}

// Recargar catálogo cada hora
setInterval(() => {
  catalogoCache = null;
  datosEmpresaCache = null;
  console.log('🔄 Recargando catálogo y datos de empresa...');
}, 3600000);

// ============================================
// BÚSQUEDA DE PRODUCTOS
// ============================================

function buscarProductos(consulta) {
  const catalogo = cargarCatalogo();
  const consultaLower = consulta.toLowerCase();
  const palabras = consultaLower.split(/\s+/).filter(p => p.length > 2);
  
  let productosIds = new Set();
  
  // Buscar en índices rápidos
  if (catalogo.indices) {
    // Buscar por categoría
    for (const [categoria, ids] of Object.entries(catalogo.indices.por_categoria || {})) {
      if (palabras.some(p => categoria.toLowerCase().includes(p))) {
        ids.forEach(id => productosIds.add(id));
      }
    }
    
    // Buscar por marca
    for (const [marca, ids] of Object.entries(catalogo.indices.por_marca || {})) {
      if (palabras.some(p => marca.toLowerCase().includes(p))) {
        ids.forEach(id => productosIds.add(id));
      }
    }
  }
  
  // Si no encontró nada en índices, buscar en todos los productos
  if (productosIds.size === 0) {
    catalogo.productos.forEach((prod, idx) => {
      const score = calcularScore(prod, palabras);
      if (score > 0) {
        productosIds.add(idx);
      }
    });
  }
  
  // Obtener productos y ordenar por relevancia
  const productos = Array.from(productosIds)
    .map(id => catalogo.productos[id])
    .filter(p => p)
    .map(p => ({
      ...p,
      score: calcularScore(p, palabras)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); // Top 10
  
  return productos;
}

function calcularScore(producto, palabras) {
  let score = 0;
  
  palabras.forEach(palabra => {
    // Nombre (peso 3)
    if (producto.nombre.toLowerCase().includes(palabra)) score += 3;
    
    // Keywords (peso 2)
    if (producto.keywords && producto.keywords.some(k => k.includes(palabra))) score += 2;
    
    // Categoría (peso 2)
    if (producto.categoria_principal && producto.categoria_principal.toLowerCase().includes(palabra)) score += 2;
    
    // Material (peso 1)
    if (producto.material && producto.material.toLowerCase().includes(palabra)) score += 1;
    
    // Marca (peso 1)
    if (producto.marca && producto.marca.toLowerCase().includes(palabra)) score += 1;
  });
  
  // Bonus por stock disponible
  if (producto.stock > 0) score += 1;
  
  return score;
}

// ============================================
// RESPUESTAS AUTOMÁTICAS
// ============================================

function generarRespuestaAutomatica(mensaje) {
  const msgLower = mensaje.toLowerCase();
  const datosEmpresa = cargarDatosEmpresa();
  
  // Horarios
  if (msgLower.includes('horario') || msgLower.includes('hora') || msgLower.includes('abierto')) {
    return {
      automatica: true,
      respuesta: `📅 Nuestros horarios de atención son:\n\n${datosEmpresa.horarios.descripcion}\n\n¿En qué más puedo ayudarte?`
    };
  }
  
  // Ubicación
  if (msgLower.includes('ubicacion') || msgLower.includes('ubicación') || msgLower.includes('dirección') || msgLower.includes('direccion') || msgLower.includes('donde')) {
    return {
      automatica: true,
      respuesta: `📍 Nos encontramos en:\n${datosEmpresa.ubicacion.direccion.completa}\n\n🗺️ Ver en Google Maps: ${datosEmpresa.ubicacion.google_maps.link}\n\n¿Necesitás algo más?`
    };
  }
  
  // Contacto
  if (msgLower.includes('telefono') || msgLower.includes('teléfono') || msgLower.includes('contacto') || msgLower.includes('llamar')) {
    return {
      automatica: true,
      respuesta: `📞 Podés contactarnos por:\n\n• WhatsApp: ${datosEmpresa.contacto.whatsapp.numero}\n• Teléfono: ${datosEmpresa.contacto.telefono.formateado}\n• Email: ${datosEmpresa.contacto.email.ventas}\n\n¿En qué puedo ayudarte?`
    };
  }
  
  // Formas de pago
  if (msgLower.includes('pago') || msgLower.includes('tarjeta') || msgLower.includes('efectivo') || msgLower.includes('transferencia')) {
    return {
      automatica: true,
      respuesta: `💳 Aceptamos:\n${datosEmpresa.metodos_pago.descripcion}\n\n¿Querés consultar algún producto?`
    };
  }
  
  // Envíos
  if (msgLower.includes('envio') || msgLower.includes('envío') || msgLower.includes('delivery') || msgLower.includes('entregan')) {
    return {
      automatica: true,
      respuesta: `🚚 Realizamos envíos en ${datosEmpresa.envios.zona_cobertura}\n✓ Retiro gratuito en sucursal\n\n¿Necesitás cotizar un envío específico?`
    };
  }
  
  return null;
}

// ============================================
// GENERACIÓN DE RESPUESTA CON IA
// ============================================

async function generarRespuestaIA(mensaje, productos, historial) {
  const datosEmpresa = cargarDatosEmpresa();
  
  // System prompt con información de la empresa
  const systemPrompt = `Sos el asistente virtual de ${datosEmpresa.empresa.nombre_completo}.

INFORMACIÓN DE LA EMPRESA:
📍 Ubicación: ${datosEmpresa.ubicacion.direccion.completa}
📞 Teléfono: ${datosEmpresa.contacto.telefono.formateado}
📱 WhatsApp: ${datosEmpresa.contacto.whatsapp.numero}
📧 Email: ${datosEmpresa.contacto.email.ventas}
🕐 Horarios: ${datosEmpresa.horarios.descripcion}

MÉTODOS DE PAGO:
${datosEmpresa.metodos_pago.descripcion}

ENVÍOS:
${datosEmpresa.envios.disponible ? `Realizamos envíos en ${datosEmpresa.envios.zona_cobertura}` : 'Retiro en sucursal'}
${datosEmpresa.envios.retiro_sucursal.disponible ? '✓ Retiro gratuito en sucursal' : ''}

ESPECIALIDADES:
${datosEmpresa.informacion_adicional.especialidades.join(', ')}

TU ROL:
- Sos un vendedor experto y amable de ${datosEmpresa.empresa.nombre}
- Conocés todos los productos del catálogo
- Ayudás a los clientes con consultas de stock, precios y asesoramiento técnico
- Tono conversacional argentino (tuteá al cliente)

REGLAS CRÍTICAS:
1. SIEMPRE mencioná los PRECIOS que te doy en el catálogo
2. SIEMPRE mencioná el STOCK disponible
3. Si te paso productos, USÁ ESA INFORMACIÓN
4. Sé específico con los números (precios, stock, medidas)
5. Para consultas complejas o presupuestos grandes, sugerí contactar por WhatsApp

CONTACTO RÁPIDO:
Para consultas urgentes: ${datosEmpresa.contacto.whatsapp.link}`;

  // Contexto de productos
  const contextoProductos = productos.length > 0
    ? `PRODUCTOS DISPONIBLES (recomendá alguno de estos):\n\n${productos.map(p => 
        `- ${p.nombre}
  SKU: ${p.sku}
  PRECIO: $${p.precio.toLocaleString('es-AR')}
  STOCK: ${p.stock} unidades disponibles
  ${p.material ? `Material: ${p.material}` : ''}
  ${p.medidas ? `Medidas: ${p.medidas}` : ''}`
      ).join('\n\n')}`
    : 'No se encontraron productos exactos para esta consulta. Ofrecé consultar por WhatsApp o buscar alternativas.';
  
  // Construir mensajes para OpenAI
  const mensajes = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: contextoProductos },
    ...historial,
    { role: 'user', content: mensaje }
  ];
  
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: mensajes,
      temperature: 0.7,
      max_tokens: 500
    });
    
    return completion.choices[0].message.content;
    
  } catch (error) {
    console.error('Error OpenAI:', error);
    throw new Error('Error al generar respuesta');
  }
}

// ============================================
// ENDPOINTS
// ============================================

// Endpoint principal del chat
router.post('/chat', async (req, res) => {
  try {
    const { mensaje, historial = [] } = req.body;
    
    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }
    
    console.log('📨 Mensaje recibido:', mensaje);
    
    // 1. Verificar si hay respuesta automática
    const respuestaAuto = generarRespuestaAutomatica(mensaje);
    if (respuestaAuto) {
      console.log('⚡ Respuesta automática generada');
      return res.json({
        respuesta: respuestaAuto.respuesta,
        productos: [],
        timestamp: new Date().toISOString()
      });
    }
    
    // 2. Buscar productos relevantes
    const productosRelevantes = buscarProductos(mensaje);
    console.log(`🔍 Productos encontrados: ${productosRelevantes.length}`);
    
    // 3. Generar respuesta con IA
    const respuesta = await generarRespuestaIA(
      mensaje,
      productosRelevantes,
      historial
    );
    
    res.json({
      respuesta: respuesta,
      productos: productosRelevantes.slice(0, 3), // Top 3 para mostrar
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      error: 'Error al procesar mensaje',
      detalles: error.message
    });
  }
});

// Endpoint para obtener catálogo completo (para presupuestos)
router.get('/productos', (req, res) => {
  try {
    const catalogo = cargarCatalogo();
    
    res.json({
      metadata: catalogo.metadata,
      indices: catalogo.indices,
      productos: catalogo.productos.filter(p => p.activo && p.visible)
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