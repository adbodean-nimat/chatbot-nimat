require('dotenv').config();
const Dropbox = require('dropbox').Dropbox;
const xlsx = require('xlsx');
const fs = require('fs');
const cron = require('node-cron');

const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN ;
const EXCEL_PATH = process.env.EXCEL_PATH ;
const OUTPUT_JSON = process.env.OUTPUT_JSON ; 

function limpiarHtml(texto) {
  if (!texto) return '';
  return texto.replace(/<[^>]+>/g, '').trim();
}

function extraerMedidas(nombre) {
  const match = nombre.toLowerCase().match(/(\d+x\d+(?:x\d+)?)/);
  return match ? match[0] : '';
}

function extraerMaterial(nombre) {
  const materiales = ['cedro', 'pino', 'aluminio', 'pvc', 'chapa'];
  const lower = nombre.toLowerCase();
  for (const mat of materiales) {
    if (lower.includes(mat)) {
      return mat.charAt(0).toUpperCase() + mat.slice(1);
    }
  }
  return '';
}

function detectarCategoria(nombre) {
  const lower = nombre.toLowerCase();
  if (lower.includes('puerta')) return 'Puertas';
  if (lower.includes('aireador')) return 'Aireadores';
  if (lower.includes('cerámica')) return 'Revestimientos';
  return 'General';
}

function generarKeywords(producto) {
  const keywords = new Set();
  const textos = [
    producto.nombre,
    producto.categoria_principal,
    producto.marca,
    producto.material
  ];
  
  textos.forEach(texto => {
    if (texto) {
      texto.toLowerCase().split(/\s+/)
        .filter(p => p.length > 2)
        .forEach(p => keywords.add(p));
    }
  });
  
  return Array.from(keywords);
}

function construirIndices(productos) {
  const indices = {
    por_categoria: {},
    por_marca: {},
    por_rango_precio: {
      economico: [],
      medio: [],
      premium: [],
      alto: []
    },
    busqueda_rapida: {}
  };
  
  productos.forEach((prod, idx) => {
    // Por categoría
    if (!indices.por_categoria[prod.categoria_principal]) {
      indices.por_categoria[prod.categoria_principal] = [];
    }
    indices.por_categoria[prod.categoria_principal].push(idx);
    
    // Por marca
    if (prod.marca) {
      if (!indices.por_marca[prod.marca]) {
        indices.por_marca[prod.marca] = [];
      }
      indices.por_marca[prod.marca].push(idx);
    }
    
    // Por precio
    if (prod.precio < 50000) {
      indices.por_rango_precio.economico.push(idx);
    } else if (prod.precio < 150000) {
      indices.por_rango_precio.medio.push(idx);
    } else if (prod.precio < 250000) {
      indices.por_rango_precio.premium.push(idx);
    } else {
      indices.por_rango_precio.alto.push(idx);
    }
  });
  
  return indices;
}

async function sincronizarProductos() {
  try {
    console.log('Iniciando sincronización...');
    
    const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN });
    const response = await dbx.filesDownload({ path: EXCEL_PATH });
    const buffer = response.result.fileBinary;
    
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);
    
    const productos = data
      .filter(row => row.Published === 'TRUE' && row.VisibleIndividually === 'TRUE')
      .map((row, idx) => ({
        id: idx,
        sku: row.SKU || '',
        nombre: row.Name || '',
        descripcion_corta: limpiarHtml(row.ShortDescription || ''),
        categoria_principal: detectarCategoria(row.Name || ''),
        marca: row.Manufacturers || '',
        material: extraerMaterial(row.Name || ''),
        medidas: extraerMedidas(row.Name || ''),
        precio: parseFloat(row.Price) || 0,
        stock: parseInt(row.StockQuantity) || 0,
        peso_kg: parseFloat(row.Weight) || 0,
        keywords: []
      }));
    
    // Generar keywords
    productos.forEach(p => {
      p.keywords = generarKeywords(p);
    });
    
    const indices = construirIndices(productos);
    
    const jsonOptimizado = {
      metadata: {
        ultima_actualizacion: new Date().toISOString(),
        total_productos: productos.length
      },
      indices: indices,
      productos: productos
    };
    
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(jsonOptimizado, null, 2));
    
    console.log('✓ Sincronización completa:', productos.length, 'productos');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

sincronizarProductos();

cron.schedule('0 */2 * * *', () => {
  console.log('Ejecutando sincronización programada...');
  sincronizarProductos();
});

console.log('Sincronizador iniciado - cada 2 horas');