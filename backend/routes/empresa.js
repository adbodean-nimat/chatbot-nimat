const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

let datosEmpresaCache = null;

function cargarDatosEmpresa() {
  if (!datosEmpresaCache) {
    const rutaJson = path.join(__dirname, '../data/datos.json');
    const data = fs.readFileSync(rutaJson, 'utf8');
    datosEmpresaCache = JSON.parse(data);
  }
  return datosEmpresaCache;
}

// Recargar datos cada hora
setInterval(() => {
  datosEmpresaCache = null;
  console.log('🔄 Recargando datos de empresa...');
}, 3600000);

// Endpoint público para obtener datos de la empresa
router.get('/empresa', (req, res) => {
  try {
    const datos = cargarDatosEmpresa();
    
    // Devolver solo datos públicos
    res.json({
      nombre: datos.empresa.nombre_completo,
      slogan: datos.empresa.slogan,
      contacto: {
        telefono: datos.contacto.telefono.formateado,
        whatsapp: datos.contacto.whatsapp.link,
        email: datos.contacto.email.ventas
      },
      ubicacion: {
        direccion: datos.ubicacion.direccion.completa,
        google_maps: datos.ubicacion.google_maps.link
      },
      horarios: datos.horarios.descripcion,
      redes_sociales: datos.redes_sociales
    });
    
  } catch (error) {
    console.error('Error al cargar datos de empresa:', error);
    res.status(500).json({ error: 'Error al cargar información' });
  }
});

// Endpoint para usar en el chatbot (con más detalles)
router.get('/empresa/chatbot', (req, res) => {
  try {
    const datos = cargarDatosEmpresa();
    
    // Devolver datos formateados para el chatbot
    res.json({
      info_basica: {
        nombre: datos.empresa.nombre_completo,
        ubicacion: datos.ubicacion.direccion.completa,
        horarios: datos.horarios.descripcion
      },
      contacto: {
        whatsapp: {
          numero: datos.contacto.whatsapp.numero,
          link: datos.contacto.whatsapp.link,
          mensaje: datos.contacto.whatsapp.mensaje_predeterminado
        },
        telefono: datos.contacto.telefono.formateado,
        email: datos.contacto.email.ventas
      },
      servicios: {
        metodos_pago: datos.metodos_pago.descripcion,
        envios: datos.envios.zona_cobertura,
        especialidades: datos.informacion_adicional.especialidades
      },
      google_maps: datos.ubicacion.google_maps.link
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al cargar información' });
  }
});

module.exports = router;