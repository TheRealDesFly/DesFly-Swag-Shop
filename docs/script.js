/* Weather dashboard
   - Uses Nominatim for geocoding (no key)
   - Uses Open-Meteo for current + daily forecast (no key)
*/

const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const statusEl = document.getElementById('status');
const currentCard = document.getElementById('current');
const placeEl = document.getElementById('place');
const tempEl = document.getElementById('temperature');
const condEl = document.getElementById('condition');
const extrasEl = document.getElementById('extras');
const forecastSection = document.getElementById('daily');
const forecastGrid = document.getElementById('forecast');
const useLocBtn = document.getElementById('use-loc');

const STORAGE_KEY = 'weather:lastPlace';

function setStatus(msg){
  statusEl.textContent = msg || '';
}

function showError(msg){
  setStatus(msg);
  currentCard.classList.add('hidden');
  forecastSection.classList.add('hidden');
}

function mapWeatherCode(code){
  // simplified mapping from Open-Meteo weathercode to description & emoji
  const map = {
    0: ['Clear sky','☀️'],
    1: ['Mainly clear','🌤️'],
    2: ['Partly cloudy','⛅'],
    3: ['Overcast','☁️'],
    45: ['Fog','🌫️'],
    48: ['Depositing rime fog','🌫️'],
    51: ['Light drizzle','🌦️'],
    53: ['Moderate drizzle','🌧️'],
    55: ['Dense drizzle','🌧️'],
    56: ['Light freezing drizzle','🧊'],
    57: ['Dense freezing drizzle','🧊'],
    61: ['Slight rain','🌧️'],
    63: ['Moderate rain','🌧️'],
    65: ['Heavy rain','⛈️'],
    66: ['Light freezing rain','🧊'],
    67: ['Heavy freezing rain','🧊'],
    71: ['Slight snow','🌨️'],
    73: ['Moderate snow','🌨️'],
    75: ['Heavy snow','❄️'],
    80: ['Rain showers','🌦️'],
    81: ['Moderate rain showers','🌧️'],
    82: ['Violent rain showers','⛈️'],
    95: ['Thunderstorm','⛈️'],
    96: ['Thunderstorm with hail','🌩️'],
    99: ['Severe thunderstorm with hail','🌩️']
  };
  return map[code] || ['Unknown','❔'];
}

async function geocode(query){
  // Nominatim geocoding
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  setStatus('Searching location…');
  const res = await fetch(url, {headers:{'Accept':'application/json'}});
  if(!res.ok) throw new Error('Geocoding request failed');
  const data = await res.json();
  if(!data || data.length === 0) throw new Error('Location not found');
  const item = data[0];
  return {
    name: item.display_name,
    lat: Number(item.lat),
    lon: Number(item.lon)
  };
}

async function fetchWeather(lat, lon){
  // Open-Meteo request: current + daily
  setStatus('Fetching weather…');
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('current_weather', 'true');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weathercode');
  url.searchParams.set('hourly', 'temperature_2m,relativehumidity_2m,precipitation');
  url.searchParams.set('timezone', 'auto');

  const res = await fetch(url.toString());
  if(!res.ok) throw new Error('Weather API request failed');
  return res.json();
}

function renderCurrent(placeName, weatherData){
  if(!weatherData || !weatherData.current_weather) {
    throw new Error('No current weather data');
  }
  placeEl.textContent = placeName;
  const cw = weatherData.current_weather;
  const temp = Math.round(cw.temperature);
  const [desc, emoji] = mapWeatherCode(cw.weathercode);

  tempEl.textContent = `${temp}°C`;
  condEl.textContent = `${emoji} ${desc}`;
  extrasEl.innerHTML = `
    Wind: ${cw.windspeed} km/h • Direction: ${cw.winddirection}° • Time: ${new Date(cw.time).toLocaleString()}
  `;

  currentCard.classList.remove('hidden');
}

function renderDaily(data){
  if(!data.daily) return;
  forecastGrid.innerHTML = '';
  const days = data.daily.time;
  const highs = data.daily.temperature_2m_max;
  const lows = data.daily.temperature_2m_min;
  const codes = data.daily.weathercode;

  for(let i=0;i<days.length;i++){
    const d = new Date(days[i]);
    const dayName = d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
    const [desc, emoji] = mapWeatherCode(codes[i]);
    const card = document.createElement('div');
    card.className = 'forecast-card';
    card.innerHTML = `
      <div class="day">${dayName}</div>
      <div class="icon" aria-hidden="true">${emoji}</div>
      <div class="desc">${desc}</div>
      <div class="temps">${Math.round(highs[i])}° / ${Math.round(lows[i])}°</div>
    `;
    forecastGrid.appendChild(card);
  }
  forecastSection.classList.remove('hidden');
}

async function searchAndRender(query){
  try{
    setStatus('');
    const loc = await geocode(query);
    localStorage.setItem(STORAGE_KEY, query);
    const weather = await fetchWeather(loc.lat, loc.lon);
    renderCurrent(loc.name, weather);
    renderDaily(weather);
    setStatus('');
  }catch(err){
    console.error(err);
    showError(err.message || 'Error fetching weather');
  }
}

form.addEventListener('submit', (e)=>{
  e.preventDefault();
  const q = input.value.trim();
  if(!q) return;
  searchAndRender(q);
});

useLocBtn.addEventListener('click', ()=>{
  if(!navigator.geolocation){
    showError('Geolocation not supported in this browser.');
    return;
  }
  setStatus('Determining your location…');
  navigator.geolocation.getCurrentPosition(async (pos)=>{
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    try{
      // reverse geocode for a friendly name (use Nominatim reverse)
      const rev = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
      const j = await rev.json();
      const placeName = j.display_name || `${lat.toFixed(3)},${lon.toFixed(3)}`;
      localStorage.setItem(STORAGE_KEY, placeName);
      const weather = await fetchWeather(lat, lon);
      renderCurrent(placeName, weather);
      renderDaily(weather);
      setStatus('');
    }catch(err){
      showError('Unable to fetch weather for your location.');
    }
  }, (err)=>{
    showError('Geolocation permission denied or unavailable.');
  }, {timeout:10000});
});

// on load: if last place in storage, auto-search
window.addEventListener('DOMContentLoaded', ()=>{
  const last = localStorage.getItem(STORAGE_KEY);
  if(last){
    input.value = last;
    searchAndRender(last);
  }
});
