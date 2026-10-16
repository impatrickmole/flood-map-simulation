import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';

// Insert your Mapbox token here
mapboxgl.accessToken = '#insert_your_mapbox_token_here#';

// Hardware definitions 
const HARDWARE = [
  { id: 'iot_1', name: 'IoT Sensor 1 (Macalong)', type: 'iot', lng: 120.5707, lat: 15.9758 },
  { id: 'iot_2', name: 'IoT Sensor 2 (Upstream)', type: 'iot', lng: 120.5810, lat: 15.9820 },
  { id: 'iot_3', name: 'IoT Sensor 3 (Downstream)', type: 'iot', lng: 120.5600, lat: 15.9680 },
  { id: 'edge_1', name: 'Edge AI Camera', type: 'edge', lng: 120.5715, lat: 15.9765 }
];

// Mathematical function to generate a localized, organic spreading flood polygon
const generateSpreadPolygon = (centerLng, centerLat, radiusKm) => {
  if (radiusKm === 0) return { type: 'FeatureCollection', features: [] };
  const points = 64;
  const coords = [];
  // Convert kilometers to longitudinal/latitudinal degrees
  const distanceX = radiusKm / (111.32 * Math.cos(centerLat * Math.PI / 180));
  const distanceY = radiusKm / 110.574;
  
  for(let i = 0; i < points; i++) {
      const theta = (i / points) * (2 * Math.PI);
      // Multiply X by 1.5 to create an elliptical spread (simulating an east-west river flow)
      const x = (distanceX * 1.5) * Math.cos(theta);
      const y = distanceY * Math.sin(theta);
      coords.push([centerLng + x, centerLat + y]);
  }
  coords.push(coords[0]); // Close the polygon loop
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
};

function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef({}); 
  
  // UI State
  const [showHazard, setShowHazard] = useState(false);
  const [activeSensor, setActiveSensor] = useState(null);
  const [forecastHour, setForecastHour] = useState(0);

  // Depth Physics: 0.5 meters (50cm) rise per hour
  const currentDepthMeters = forecastHour * 0.5;
  const currentDepthCm = currentDepthMeters * 100;

  useEffect(() => {
    if (map.current) return; 

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11', 
      center: [120.5707, 15.9758], 
      zoom: 14.5, 
      pitch: 60,  
      bearing: -17.6 
    });

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.current.on('style.load', () => {
      
      map.current.setPaintProperty('water', 'fill-color', '#00b8ff');
      map.current.setPaintProperty('water', 'fill-opacity', 0.8);

      // Add 3D Terrain
      map.current.addSource('mapbox-dem', {
        'type': 'raster-dem',
        'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
        'tileSize': 512,
        'maxzoom': 14
      });
      map.current.setTerrain({ 'source': 'mapbox-dem', 'exaggeration': 1.5 });

      const layers = map.current.getStyle().layers;
      const labelLayerId = layers.find((l) => l.type === 'symbol' && l.layout['text-field'])?.id;

      // Add 3D Buildings
      map.current.addLayer({
        'id': 'add-3d-buildings',
        'source': 'composite',
        'source-layer': 'building',
        'filter': ['==', 'extrude', 'true'],
        'type': 'fill-extrusion',
        'minzoom': 14,
        'paint': {
          'fill-extrusion-color': '#e0e0e0', 
          'fill-extrusion-height': ['get', 'height'], 
          'fill-extrusion-base': ['get', 'min_height'],
          'fill-extrusion-opacity': 0.9
        }
      }, labelLayerId);

      // NOAH Hazard Overlay (Updated to concentric zones simulating riverbanks)
      map.current.addSource('noah-hazard', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            // Red (High) - Immediate Riverbank
            { type: 'Feature', properties: { level: 'high' }, geometry: { type: 'Polygon', coordinates: [[[120.560, 15.978], [120.585, 15.978], [120.585, 15.973], [120.560, 15.973], [120.560, 15.978]]] } },
            // Orange (Medium) - Secondary Floodplain
            { type: 'Feature', properties: { level: 'medium' }, geometry: { type: 'Polygon', coordinates: [[[120.555, 15.981], [120.590, 15.981], [120.590, 15.970], [120.555, 15.970], [120.555, 15.981]]] } },
            // Yellow (Low) - Outskirts
            { type: 'Feature', properties: { level: 'low' }, geometry: { type: 'Polygon', coordinates: [[[120.550, 15.984], [120.595, 15.984], [120.595, 15.967], [120.550, 15.967], [120.550, 15.984]]] } }
          ]
        }
      });

      map.current.addLayer({
        id: 'hazard-layer',
        type: 'fill',
        source: 'noah-hazard',
        layout: { 'visibility': 'none' }, 
        paint: {
          'fill-color': ['match', ['get', 'level'], 'high', '#ff0000', 'medium', '#ffa500', 'low', '#ffff00', '#aaaaaa'],
          'fill-opacity': 0.3 // Kept transparent so we can see the blue water rise over it
        }
      }, labelLayerId);

      // The Dynamic Flood Source (Starts empty)
      map.current.addSource('dynamic-flood', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      // The Flood Render Layer
      map.current.addLayer({
        id: 'flood-extrusion',
        type: 'fill-extrusion',
        source: 'dynamic-flood',
        layout: { 'visibility': 'none' },
        paint: {
          'fill-extrusion-color': '#0033ff', 
          'fill-extrusion-height': 0, 
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.75 
        }
      }, labelLayerId);

      // Initialize Hardware Markers
      HARDWARE.forEach(hw => {
        const el = document.createElement('div');
        el.style.width = hw.type === 'edge' ? '24px' : '18px';
        el.style.height = hw.type === 'edge' ? '24px' : '18px';
        el.style.borderRadius = hw.type === 'edge' ? '4px' : '50%';
        el.style.backgroundColor = hw.type === 'edge' ? '#9c27b0' : '#00cc66'; 
        el.style.border = '2px solid white';
        el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
        el.style.transition = 'all 0.3s ease';

        const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`<strong>${hw.name}</strong><br/>Status: Normal`);

        const marker = new mapboxgl.Marker(el)
          .setLngLat([hw.lng, hw.lat])
          .setPopup(popup)
          .addTo(map.current);
          
        markersRef.current[hw.id] = { marker, el, popup, data: hw };
      });
    });

  }, []);

  // Toggle Hazard Map
  useEffect(() => {
    if (map.current && map.current.getLayer('hazard-layer')) {
      map.current.setLayoutProperty('hazard-layer', 'visibility', showHazard ? 'visible' : 'none');
    }
  }, [showHazard]);

  // Handle Simulation Spread
  useEffect(() => {
    if (!map.current || !map.current.getLayer('flood-extrusion')) return;

    // Reset markers
    Object.values(markersRef.current).forEach(item => {
      if (item.data.type === 'iot') {
        item.el.style.backgroundColor = '#00cc66';
        item.el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
        item.popup.setHTML(`<strong>${item.data.name}</strong><br/>Status: Normal`);
      }
    });

    if (activeSensor) {
      const activeData = markersRef.current[activeSensor];
      
      activeData.el.style.backgroundColor = '#ff0000';
      activeData.el.style.boxShadow = '0 0 20px 8px rgba(255, 0, 0, 0.8)';
      activeData.popup.setHTML(`<strong>${activeData.data.name}</strong><br/><span style="color:red;font-weight:bold;">ALERT: Rapid Rise Detected</span>`);
      
      if (forecastHour > 0) {
        // Calculate the physical spread area (e.g., expands 150 meters per hour)
        const radiusKm = forecastHour * 0.15; 
        const newFloodGeoJSON = generateSpreadPolygon(activeData.data.lng, activeData.data.lat, radiusKm);
        
        // Feed the new, larger polygon to Mapbox
        map.current.getSource('dynamic-flood').setData(newFloodGeoJSON);
        map.current.setLayoutProperty('flood-extrusion', 'visibility', 'visible');
        map.current.setPaintProperty('flood-extrusion', 'fill-extrusion-height', currentDepthMeters);
      } else {
        map.current.setLayoutProperty('flood-extrusion', 'visibility', 'none');
      }
      
      if (forecastHour === 0) {
        map.current.flyTo({ center: [activeData.data.lng, activeData.data.lat], zoom: 15, essential: true });
      }
    } else {
      map.current.setLayoutProperty('flood-extrusion', 'visibility', 'none');
    }
  }, [activeSensor, forecastHour]);

  const triggerSensor = (sensorId) => {
    setActiveSensor(sensorId);
    setForecastHour(0); 
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', fontFamily: 'sans-serif' }}>
      
      {/* COMMAND PANEL */}
      <div style={{
        position: 'absolute', top: 20, left: 20, zIndex: 1, 
        backgroundColor: 'rgba(25, 25, 25, 0.95)', color: 'white', 
        padding: '20px', borderRadius: '12px', width: '320px',
        boxShadow: '0 8px 16px rgba(0,0,0,0.5)'
      }}>
        <h2 style={{ margin: '0 0 15px 0', borderBottom: '1px solid #444', paddingBottom: '10px' }}>Digital Twin Command</h2>
        
        <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Flood Hazard Level</span>
          <input type="checkbox" checked={showHazard} onChange={() => setShowHazard(!showHazard)} style={{ width: '18px', height: '18px', cursor: 'pointer' }} />
        </div>

        {showHazard && (
          <div style={{ marginBottom: '20px', padding: '10px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: '6px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}><div style={{ width: '15px', height: '15px', backgroundColor: '#ff0000', marginRight: '10px' }}></div> High (Low-Lying Riverbeds)</div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}><div style={{ width: '15px', height: '15px', backgroundColor: '#ffa500', marginRight: '10px' }}></div> Medium (Floodplain)</div>
            <div style={{ display: 'flex', alignItems: 'center' }}><div style={{ width: '15px', height: '15px', backgroundColor: '#ffff00', marginRight: '10px' }}></div> Low (Outskirts)</div>
          </div>
        )}

        <div style={{ borderTop: '1px solid #444', paddingTop: '15px' }}>
          <h4 style={{ margin: '0 0 10px 0', color: '#aaa' }}>Hardware Simulators (IoT)</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {HARDWARE.filter(hw => hw.type === 'iot').map(hw => (
              <button 
                key={hw.id}
                onClick={() => triggerSensor(hw.id)}
                style={{
                  padding: '10px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 'bold',
                  backgroundColor: activeSensor === hw.id ? '#ff4444' : '#333',
                  color: 'white', transition: 'background-color 0.2s'
                }}
              >
                Trigger {hw.name}
              </button>
            ))}
          </div>
          {activeSensor && (
            <button 
              onClick={() => { setActiveSensor(null); setForecastHour(0); }}
              style={{ marginTop: '10px', width: '100%', padding: '8px', backgroundColor: 'transparent', border: '1px solid #666', color: '#ccc', borderRadius: '6px', cursor: 'pointer' }}
            >
              Reset Sensors
            </button>
          )}
        </div>
      </div>

      {activeSensor && (
        <div style={{
          position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 1,
          backgroundColor: '#ff0000', color: 'white', padding: '15px 30px', borderRadius: '50px',
          fontWeight: 'bold', fontSize: '1.2rem', boxShadow: '0 0 20px rgba(255,0,0,0.6)',
          animation: 'pulse 1.5s infinite'
        }}>
          ⚠️ CRITICAL ALERT: Sensor {activeSensor.replace('iot_', '')} breached threshold.
        </div>
      )}

      {activeSensor && (
        <div style={{
          position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)', zIndex: 1,
          backgroundColor: 'rgba(20, 20, 20, 0.95)', color: 'white', padding: '20px', 
          borderRadius: '12px', width: '500px', boxShadow: '0 8px 16px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', alignItems: 'center'
        }}>
          <h3 style={{ margin: '0 0 5px 0', color: '#00ccff' }}>Time-Series Simulation</h3>
          <p style={{ margin: '0 0 15px 0', fontSize: '18px', fontWeight: 'bold', color: '#ff4444' }}>
            Current Depth: {currentDepthCm} cm
          </p>
          
          <input 
            type="range" min="0" max="12" step="1" 
            value={forecastHour} 
            onChange={(e) => setForecastHour(parseInt(e.target.value))} 
            style={{ width: '100%', cursor: 'pointer' }}
          />
          
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginTop: '10px', fontWeight: 'bold', fontSize: '14px', color: '#aaa' }}>
            <span>Current Time (T+0)</span>
            <span style={{ color: 'white' }}>T+{forecastHour} Hours</span>
            <span>T+12 Hours</span>
          </div>
        </div>
      )}

      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      <style>{`
        @keyframes pulse {
          0% { transform: translateX(-50%) scale(1); opacity: 1; }
          50% { transform: translateX(-50%) scale(1.05); opacity: 0.9; }
          100% { transform: translateX(-50%) scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

export default App;