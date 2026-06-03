print("script started")
import geopandas as gpd

shp = r"C:\Users\peace\.cache\kagglehub\datasets\julianjohs\shape-file-for-districts-in-vienna\versions\1\BEZIRKSGRENZEOGD\BEZIRKSGRENZEOGDPolygon.shp"

gdf = gpd.read_file(shp)
print("Current CRS:", gdf.crs)
print("Columns:", list(gdf.columns))
print(gdf.head())

gdf = gdf.to_crs("EPSG:4326")
gdf.to_file("public/data/districts.geojson", driver="GeoJSON")
print("Done! Saved to public/data/districts.geojson")