import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const key = Deno.env.get("GEOAPIFY_API_KEY");
    if (!key) throw new Error("Location service is not configured");
    const u = new URL(req.url);
    const mode = u.searchParams.get("mode") || "autocomplete";
    let target: URL;

    if (mode === "nearby") {
      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Invalid coordinates");
      target = new URL("https://api.geoapify.com/v2/places");
      target.searchParams.set("categories","commercial,building.commercial,building.industrial");
      target.searchParams.set("filter",`circle:${lon},${lat},2000`);
      target.searchParams.set("bias",`proximity:${lon},${lat}`);
      target.searchParams.set("limit","15");
    } else {
      let q = (u.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({results:[]});
      // Truckers commonly search compact depot codes such as "CEVA DC3 Kettering".
      // Expanding DC tokens improves geocoder recall without changing what the user typed.
      const expanded = q.replace(/\bdc\s*([0-9]+)\b/ig, "distribution centre $1");
      target = new URL("https://api.geoapify.com/v1/geocode/autocomplete");
      target.searchParams.set("text", expanded);
      target.searchParams.set("filter","countrycode:gb");
      target.searchParams.set("bias","countrycode:gb");
      target.searchParams.set("format","json");
      target.searchParams.set("limit","12");
    }
    target.searchParams.set("apiKey",key);
    const res = await fetch(target, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Geoapify error ${res.status}`);
    const data = await res.json();

    let results:any[] = [];
    if (mode === "nearby") {
      results = (data.features || []).map((f:any)=>({
        name: f.properties.name || f.properties.address_line1 || "Nearby location",
        address: f.properties.formatted || f.properties.address_line2 || "",
        postcode: f.properties.postcode || "",
        lat: f.properties.lat,
        lon: f.properties.lon,
        distance: f.properties.distance ?? null,
        source:"geoapify"
      }));
    } else {
      results = (data.results || []).map((p:any)=>({
        name: p.name || p.address_line1 || p.formatted,
        address: p.formatted || "",
        postcode: p.postcode || "",
        lat:p.lat, lon:p.lon, source:"geoapify"
      }));
    }
    if (mode !== "nearby" && results.length < 3) {
      // Full name search complements prefix-oriented address autocomplete.
      const fallback = new URL(target);
      fallback.pathname = "/v1/geocode/search";
      fallback.searchParams.set("text", (u.searchParams.get("q") || "").trim());
      try {
        const extra = await fetch(fallback, { signal: AbortSignal.timeout(4000) });
        if (extra.ok) {
          const found = await extra.json();
          const seen = new Set(results.map(p => [p.name,p.postcode,p.lat,p.lon].join("|")));
          for (const p of found.results || []) {
            const place = {name:p.name || p.address_line1 || p.formatted,address:p.formatted || "",postcode:p.postcode || "",lat:p.lat,lon:p.lon,source:"geoapify"};
            const id = [place.name,place.postcode,place.lat,place.lon].join("|");
            if (!seen.has(id)) { results.push(place); seen.add(id); }
          }
        }
      } catch { /* Preserve autocomplete results when the secondary search fails. */ }
    }
    return json({results:results.slice(0,mode === "nearby" ? 15 : 12)});
  } catch (e) {
    return json({error: e instanceof Error ? e.message : "Unknown error"}, 500);
  }
});

function json(body:any,status=200){
 return new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"public, max-age=30"}});
}