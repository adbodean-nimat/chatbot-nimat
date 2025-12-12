// sync-categorias-productos.js
// Script para sincronizar categorías desde Excel y generar JSON completo
require('dotenv').config();
const Dropbox = require('dropbox').Dropbox;
const xlsx = require('xlsx');
const fs = require('fs');
const { encode } = require('@toon-format/toon')

const EXCEL_PRODUCTOS = process.env.EXCEL_PRODUCTOS_PATH
const EXCEL_CATEGORIAS = process.env.EXCEL_CATEGORIAS_PATH
const EXCEL_URLS = process.env.EXCEL_URLS_PATH
const OUTPUT_JSON = process.env.OUTPUT_JSON
const OUTPUT_TOON = process.env.OUTPUT_TOON

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
  });
  const auth = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString("base64");
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OAuth token error ${res.status}: ${errText}`);
  }
  return res.json();
}

let _cachedAccess = null;
async function ensureAccessToken() {
  const now = Date.now();
  if (_cachedAccess && _cachedAccess.expiresAt > now + 30_000) {
    return _cachedAccess.token;
  }
  const t = await getAccessToken();
  _cachedAccess = {
    token: t.access_token,
    expiresAt: now + ((t.expires_in ?? 3600) - 60) * 1000,
  };
  return _cachedAccess.token;
}

// Función para construir árbol de categorías
function construirArbolCategorias(categorias) {
  const categoriasMap = {};
  const arbol = [];
  
  // Primer paso: crear mapa de todas las categorías
  categorias.forEach(cat => {
    categoriasMap[cat.Id] = {
      id: cat.Id,
      nombre: cat.Name,
      slug: cat.SeName,
      url_categoria: 'https://www.nimat.com.ar/'+cat.SeName,
      descripcion: cat.Description || '',
      parent_id: cat.ParentCategoryId || 0,
      orden: cat.DisplayOrder || 0,
      visible: cat.Published,
      hijos: []
    };
  });
  
  // Segundo paso: construir jerarquía
  Object.values(categoriasMap).forEach(cat => {
    if (cat.parent_id === 0) {
      arbol.push(cat);
    } else {
      const padre = categoriasMap[cat.parent_id];
      if (padre) {
        padre.hijos.push(cat);
      }
    }
  });
  
  // Ordenar por DisplayOrder
  const ordenar = (cats) => {
    cats.sort((a, b) => a.orden - b.orden);
    cats.forEach(cat => {
      if (cat.hijos.length > 0) {
        ordenar(cat.hijos);
      }
    });
  };
  
  ordenar(arbol);
  
  return { arbol, mapa: categoriasMap };
}

// Función para parsear IDs de categorías desde formato "id|orden;id|orden"
function parsearCategorias(categoriesStr) {
  if (!categoriesStr || categoriesStr.trim() === '') return [];
  
  return categoriesStr.split(';')
    .map(item => {
      const [id, orden] = item.split('|').map(s => s.trim());
      return {
        id: parseInt(id),
        orden: parseInt(orden) || 0
      };
    })
    .filter(item => !isNaN(item.id));
}

// Función para enriquecer productos con info de categorías
function enriquecerProductos(productos, categoriasMap) {
  return productos.map(prod => {
    const categoriasProd = parsearCategorias(prod.categorias);
    
    // Obtener nombres de categorías
    const categoriasInfo = categoriasProd.map(cp => {
      const cat = categoriasMap[cp.id];
      if (!cat) return null;
      
      // Construir ruta completa (ej: "Construcción > Cales y Cementos")
      const ruta = [];
      let catActual = cat;
      while (catActual) {
        ruta.unshift(catActual.nombre);
        catActual = catActual.parent_id ? categoriasMap[catActual.parent_id] : null;
      }
      
      return {
        id: cp.id,
        nombre: cat.nombre,
        slug: cat.slug,
        ruta: ruta.join(' > '),
        orden: cp.orden
      };
    }).filter(c => c !== null);
    
    // Categoría principal (la primera en orden)
    const categoriaPrincipal = categoriasInfo.length > 0 
      ? categoriasInfo.sort((a, b) => a.orden - b.orden)[0]
      : null;
    
    return {
      ...prod,
      categoria_principal: categoriaPrincipal ? categoriaPrincipal.nombre : 'General',
      categoria_principal_slug: categoriaPrincipal ? categoriaPrincipal.slug : 'general',
      categorias_completas: categoriasInfo,
      ruta_categoria: categoriaPrincipal ? categoriaPrincipal.ruta : 'General',
      url_categoria: categoriaPrincipal ? 'https://www.nimat.com.ar/'+categoriaPrincipal.slug : 'https://www.nimat.com.ar/'+prod.marca
    };
  });
}

// Función para crear índices por categoría mejorados
function crearIndicesCategorias(productos, arbolCategorias) {
  const indices = {
    por_categoria_id: {},
    por_categoria_nombre: {},
    por_categoria_slug: {}
  };
  
  productos.forEach((prod, idx) => {
    prod.categorias_completas.forEach(cat => {
      // Por ID
      if (!indices.por_categoria_id[cat.id]) {
        indices.por_categoria_id[cat.id] = {
          info: cat,
          productos: []
        };
      }
      indices.por_categoria_id[cat.id].productos.push(idx);
      
      // Por nombre
      if (!indices.por_categoria_nombre[cat.nombre]) {
        indices.por_categoria_nombre[cat.nombre] = [];
      }
      indices.por_categoria_nombre[cat.nombre].push(idx);
      
      // Por slug
      if (!indices.por_categoria_slug[cat.slug]) {
        indices.por_categoria_slug[cat.slug] = [];
      }
      indices.por_categoria_slug[cat.slug].push(idx);
    });
  });
  
  return indices;
}

async function sincronizarCompleto() {
  try {
    console.log('🚀 Iniciando sincronización completa...\n');
    const token = await ensureAccessToken();
    const dbx = new Dropbox({ accessToken: token });
    
    // 1. Cargar Excel de Categorías
    console.log('📥 Descargando categorías...');
    const resCat = await dbx.filesDownload({ path: EXCEL_CATEGORIAS });
    const wbCat = xlsx.read(resCat.result.fileBinary, { type: 'buffer' });
    const categorias = xlsx.utils.sheet_to_json(wbCat.Sheets[wbCat.SheetNames[0]]);
    
    console.log(`   ✓ Categorías leídas: ${categorias.length}`);
    
    // 2. Construir árbol de categorías
    console.log('🌳 Construyendo árbol de categorías...');
    const { arbol, mapa } = construirArbolCategorias(categorias);
    
    const categoriasActivas = Object.values(mapa).filter(c => c.visible);
    console.log(`   ✓ Categorías activas: ${categoriasActivas.length}`);
    console.log(`   ✓ Categorías principales: ${arbol.length}`);
    
    // 3. Cargar Excel de Productos
    console.log('\n📥 Descargando productos...');
    const resProd = await dbx.filesDownload({ path: EXCEL_PRODUCTOS });
    const wbProd = xlsx.read(resProd.result.fileBinary, { type: 'buffer' });
    const productosRaw = xlsx.utils.sheet_to_json(wbProd.Sheets[wbProd.SheetNames[0]]);
    
    console.log(`   ✓ Productos leídos: ${productosRaw.length}`);
    
    // 3.5. Cargar Excel de URLs
    console.log('\n📥 Descargando URLs de productos...');
    const resUrls = await dbx.filesDownload({ path: EXCEL_URLS });
    const wbUrls = xlsx.read(resUrls.result.fileBinary, { type: 'buffer' });
    const urlsRaw = xlsx.utils.sheet_to_json(wbUrls.Sheets[wbUrls.SheetNames[0]]);
    
    console.log(`   ✓ URLs leídas: ${urlsRaw.length}`);
    
    // Crear mapa de URLs por SKU
    const urlsMap = {};
    urlsRaw.forEach(row => {
      const sku = (row.Sku || row.SKU || '').trim();
      if (sku) {
        urlsMap[sku] = {
          url: row.url || '',
          imageUrl: row.imageUrl || ''
        };
      }
    });
    
    console.log(`   ✓ URLs mapeadas: ${Object.keys(urlsMap).length}`);
    
    // 4. Procesar productos (combinando con URLs)
    console.log('\n🔄 Procesando productos...');
    const productosBase = productosRaw
      .filter(row => row.Published === 'TRUE' && row.VisibleIndividually === 'TRUE')
      .map((row, idx) => {
        const sku = (row.SKU || '').trim();
        const urlData = urlsMap[sku] || { url: '', imageUrl: '' };
        
        return {
          id: idx,
          sku: sku,
          nombre: row.Name || '',
          descripcion_corta: (row.ShortDescription || '').replace(/<[^>]+>/g, ''),
          precio: parseFloat(row.Price) || 0,
          stock: parseInt(row.StockQuantity) || 0,
          marca: row.Manufacturers || '',
          peso_kg: parseFloat(row.Weight) || 0,
          categorias: row.Categories || '',
          url: urlData.url,
          imageUrl: urlData.imageUrl,
          activo: true,
          visible: true,
          keywords: []
        };
      });
    
    // 5. Enriquecer productos con info de categorías
    console.log('✨ Enriqueciendo productos con categorías...');
    const productosEnriquecidos = enriquecerProductos(productosBase, mapa);
    
    // 6. Generar keywords
    productosEnriquecidos.forEach(p => {
      const keywords = new Set();
      [p.nombre, p.categoria_principal, p.marca].forEach(texto => {
        if (texto) {
          texto.toLowerCase().split(/\s+/)
            .filter(palabra => palabra.length > 2)
            .forEach(palabra => keywords.add(palabra));
        }
      });
      p.keywords = Array.from(keywords);
    });
    
    // 7. Crear índices
    console.log('📑 Creando índices...');
    const indicesCategorias = crearIndicesCategorias(productosEnriquecidos, arbol);
    
    // Índices adicionales (por marca, precio, etc.)
    const indicesMarca = {};
    const indicesPrecio = { economico: [], medio: [], premium: [], alto: [] };
    
    productosEnriquecidos.forEach((prod, idx) => {
      // Por marca
      if (prod.marca) {
        if (!indicesMarca[prod.marca]) indicesMarca[prod.marca] = [];
        indicesMarca[prod.marca].push(idx);
      }
      
      // Por precio
      if (prod.precio < 50000) indicesPrecio.economico.push(idx);
      else if (prod.precio < 150000) indicesPrecio.medio.push(idx);
      else if (prod.precio < 250000) indicesPrecio.premium.push(idx);
      else indicesPrecio.alto.push(idx);
    });
    
    // 8. Crear estructura final
    const catalogoCompleto = {
      metadata: {
        ultima_actualizacion: new Date().toISOString(),
        total_productos: productosEnriquecidos.length,
        productos_disponibles: productosEnriquecidos.filter(p => p.stock > 0).length,
        total_categorias: categoriasActivas.length,
        categorias_principales: arbol.length,
        marcas_total: Object.keys(indicesMarca).length
      },
      
      categorias: {
        arbol: arbol,
        todas: categoriasActivas.map(c => ({
          id: c.id,
          nombre: c.nombre,
          slug: c.slug,
          parent_id: c.parent_id
        }))
      },
      
      indices: {
        por_categoria_id: indicesCategorias.por_categoria_id,
        por_categoria_nombre: indicesCategorias.por_categoria_nombre,
        por_categoria_slug: indicesCategorias.por_categoria_slug,
        por_marca: indicesMarca,
        por_rango_precio: indicesPrecio
      },
      
      productos: productosEnriquecidos
    };
    
    // 9. Guardar JSON
    const catalogoCompletoToJSON = JSON.stringify(catalogoCompleto, null, 2);
    const catalogoCompletoToTOON = encode(catalogoCompleto);

// --- LÓGICA DE SELECCIÓN DE CATEGORÍA ---
let rawData = catalogoCompleto.productos

// Función Helper: Elegir la categoría más descriptiva
function elegirMejorCategoria(data) {
  let categoriaGanadora = "General"; // Valor por defecto (Plan D)
  let urlCategoriaGanadora = "https://www.nimat.com.ar/"; // Default
  
  if (Array.isArray(data.categorias_completas) && data.categorias_completas.length > 0) {
    
    const categoriaMasProfunda = data.categorias_completas.sort((a, b) => {
        const profundidadA = (a.ruta.match(/>/g) || []).length;
        const profundidadB = (b.ruta.match(/>/g) || []).length;
        return profundidadB - profundidadA; // De mayor a menor
    })[0];
    
    categoriaGanadora = categoriaMasProfunda.ruta;
    // Intentamos armar la URL con el slug de esa categoría específica
    if (categoriaMasProfunda.slug) {
        urlCategoriaGanadora = `https://www.nimat.com.ar/${categoriaMasProfunda.slug}`;
    }

// PLAN B: Si no hay array, usamos el campo plano 'ruta_categoria' si existe
} else if (rawData.ruta_categoria) {
    categoriaGanadora = rawData.ruta_categoria;
    // Usamos la URL de categoría que ya viene en el root
    if (rawData.url_categoria) urlCategoriaGanadora = rawData.url_categoria;

// PLAN C: Usamos la 'categoria_principal' como último recurso
} else if (rawData.categoria_principal) {
    categoriaGanadora = rawData.categoria_principal;
    if (rawData.url_categoria) urlCategoriaGanadora = rawData.url_categoria;
}
return categoriaGanadora
    } 

    function elegirMejorUrlCategoria(data) {
  let categoriaGanadora = "General"; // Valor por defecto (Plan D)
  let urlCategoriaGanadora = "https://www.nimat.com.ar/"; // Default
  
  if (Array.isArray(data.categorias_completas) && data.categorias_completas.length > 0) {
    
    const categoriaMasProfunda = data.categorias_completas.sort((a, b) => {
        const profundidadA = (a.ruta.match(/>/g) || []).length;
        const profundidadB = (b.ruta.match(/>/g) || []).length;
        return profundidadB - profundidadA; // De mayor a menor
    })[0];
    
    categoriaGanadora = categoriaMasProfunda.ruta;
    // Intentamos armar la URL con el slug de esa categoría específica
    if (categoriaMasProfunda.slug) {
        urlCategoriaGanadora = `https://www.nimat.com.ar/${categoriaMasProfunda.slug}`;
    }

// PLAN B: Si no hay array, usamos el campo plano 'ruta_categoria' si existe
} else if (rawData.ruta_categoria) {
    categoriaGanadora = rawData.ruta_categoria;
    // Usamos la URL de categoría que ya viene en el root
    if (rawData.url_categoria) urlCategoriaGanadora = rawData.url_categoria;

// PLAN C: Usamos la 'categoria_principal' como último recurso
} else if (rawData.categoria_principal) {
    categoriaGanadora = rawData.categoria_principal;
    if (rawData.url_categoria) urlCategoriaGanadora = rawData.url_categoria;
}
return urlCategoriaGanadora
    } 

// --- PROCESO PRINCIPAL ---

const productosLimpios = rawData
  .filter(p => p.activo && p.visible && p.precio > 0)
  .map(p => {
    // 1. Resolvemos la categoría antes de crear el objeto
    const mejorCategoria = elegirMejorCategoria(p); // p.categorias puede ser array o string
    const mejorUrlCategoria = elegirMejorUrlCategoria(p)
    // 2. Extraemos palabras clave de esa categoría para ayudar al buscador
    // Ej: de "Aberturas > Ventanas" sacamos "aberturas, ventanas"
    const keywordsCategoria = mejorCategoria
      .replace(/>/g, ' ') // Cambiar > por espacio
      .split(' ')
      .filter(w => w.length > 3) // Filtrar conectores cortos
      .join(', ');

    return {
      sku: p.sku,
      nombre: p.nombre.trim(),
      marca: p.marca,
      
      // AQUI VA TU DUDA RESUELTA:
      categoria: mejorCategoria, // "Aberturas > Ventanas > Aluminio"
      
      precio: p.precio,
      stock: p.stock > 0, 
      url: p.url,
      
      // Importante: La URL de categoría debe coincidir con la categoría elegida
      // (Asumiendo que tenés ese dato, sino usá la genérica)
      url_categoria: mejorUrlCategoria,
      
      // Sumamos la categoría a las keywords para potenciar la búsqueda
      keywords: [p.keywords, keywordsCategoria].join(", ").toLowerCase()
    };
  });

    // Guardar productosLimpios en productos.json
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(productosLimpios, null, 2), 'utf8');
    fs.writeFileSync(OUTPUT_TOON, catalogoCompletoToTOON)

    // 10. Estadísticas finales
    console.log('\n✅ SINCRONIZACIÓN COMPLETA\n');
    console.log('📊 Estadísticas:');
    console.log(`   • Total productos activos: ${catalogoCompleto.metadata.total_productos}`);
    console.log(`   • Con stock: ${catalogoCompleto.metadata.productos_disponibles}`);
    console.log(`   • Categorías activas: ${catalogoCompleto.metadata.total_categorias}`);
    console.log(`   • Categorías principales: ${catalogoCompleto.metadata.categorias_principales}`);
    console.log(`   • Marcas: ${catalogoCompleto.metadata.marcas_total}`);
    console.log(`\n💾 Archivo generado: ${OUTPUT_JSON}`);
    console.log(`💾 Archivo generado: ${OUTPUT_TOON}`);
    console.log(`📦 Tamaño JSON: ${(fs.statSync(OUTPUT_JSON).size / 1024).toFixed(2)} KB`);
    console.log(`📦 Tamaño TOON: ${(fs.statSync(OUTPUT_TOON).size / 1024).toFixed(2)} KB\n`);
    
    // Mostrar algunas categorías principales
    console.log('🌳 Categorías principales:');
    arbol.slice(0, 5).forEach(cat => {
      console.log(`   • ${cat.nombre} (${cat.hijos.length} subcategorías)`);
    });
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error);
  }
}

// Ejecutar
sincronizarCompleto();