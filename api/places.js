export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GOOGLE_KEY = process.env.GOOGLE_PLACES_KEY;
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google Places key not configured' });

  const { keyword, lat, lng, radius } = req.body;
  if (!keyword || !lat || !lng) return res.status(400).json({ error: 'Missing params' });

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.nationalPhoneNumber,places.regularOpeningHours,places.types,places.location',
      },
      body: JSON.stringify({
        textQuery: keyword,
        rankPreference: 'DISTANCE',
        locationBias: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: radius || 5000,
          }
        },
        maxResultCount: 20,
        languageCode: 'en',
      }),
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
