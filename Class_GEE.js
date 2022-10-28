
//Initial settings
//1. Upload .zip compressed shp files and set with roi
//2. Select the drawing tool and select non-forest and forest swatches
//3. Edit the Geometries
//a) Rename the geometries (samples),
//b) Select import as "FeatureCollection",
//c) In Property write "landcover" and in Value "0" for forest and "1" non-forest pair
//4. Rename files and folder to export

//Indices (only ndvi and bsi)
var addIndices = function(image) {
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename(['ndvi']);
  var bsi = image.expression(
      '(( X + Y ) - (A + B)) /(( X + Y ) + (A + B)) ', {
        'X': image.select('B11'), //swir1
        'Y': image.select('B4'),  //red
        'A': image.select('B8'), // nir
        'B': image.select('B2'), // blue
  }).rename('bsi');
  return image.addBands(ndvi).addBands(bsi)
} 
 
//Image normalization
function normalize(image){
  var bandNames = image.bandNames();
  // Compute min and max of the image
  var minDict = image.reduceRegion({
    reducer: ee.Reducer.min(),
    geometry: roi,
    scale: 10,
    maxPixels: 1e9,
    bestEffort: true,
    tileScale: 16
  });
  var maxDict = image.reduceRegion({
    reducer: ee.Reducer.max(),
    geometry: roi,
    scale: 20,
    maxPixels: 1e9,
    bestEffort: true,
    tileScale: 16
  });
  var mins = ee.Image.constant(minDict.values(bandNames));
  var maxs = ee.Image.constant(maxDict.values(bandNames));

  var normalized = image.subtract(mins).divide(maxs.subtract(mins))
  return normalized
}

//Prepare the images 
var s2 = ee.ImageCollection("COPERNICUS/S2_SR")
var rgbVis = {
  gamma: 2,
  min: 0,
  max: 1,
  bands: ['B4', 'B3', 'B2'],
};

var img2022 = s2
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
  .filter(ee.Filter.date('2022-10-04', '2022-10-06')) //Select the range of date
  .filter(ee.Filter.bounds(roi))
  .select('B.*')
  
print(img2022)

var comp_2022 = img2022.median().clip(roi); //reduce and clip
var comp_2022 = addIndices(comp_2022); 
var comp_2022 = normalize(comp_2022);

// Display the input composite.
Map.addLayer(comp_2022, rgbVis, 'image');

//Display indices
var ndvi = comp_2022.select("ndvi")
var bsi = comp_2022.select("bsi")

Map.addLayer(ndvi, {palette: ['white','red','orange','yellow','green'],min: -0.4, max: 1}, 'ndvi');
Map.addLayer(bsi, {palette: ['red','white','blue'],min: -0.4, max: 1}, 'bsi');

// Merge the samples
var gcp = forest.merge(no_forest).merge(water) //the first clase is 0

// Overlay the point on the image to get training data.
var train_2022 = comp_2022.sampleRegions({
  collection: gcp, 
  properties: ['landcover'], 
  scale: 10,
  tileScale: 16
});

// Add a random column and split the GCPs into training and validation set
var gcp = gcp.randomColumn()

// This being a simpler classification, we take 60% points
// for validation. Normal recommended ratio is
// 70% training, 30% validation
var trainingGcp = gcp.filter(ee.Filter.lt('random', 0.6));
var validationGcp = gcp.filter(ee.Filter.gte('random', 0.6));


// Overlay the point on the image to get training data.
var train_2022 = comp_2022.sampleRegions({
  collection: trainingGcp,
  properties: ['landcover'],
  scale: 10,
  tileScale: 16
});

// Train a classifier.
var class_2022 = ee.Classifier.smileRandomForest(50)
.train({
  features: train_2022,  
  classProperty: 'landcover',
  inputProperties: comp_2022.bandNames()
});

// Classify the image.
var classified_2022 = comp_2022.classify(class_2022);

//Majority filter
var kernel = ee.Kernel.manhattan(1);

var fmajority_2022 = classified_2022.reduceNeighborhood({
  reducer: ee.Reducer.mode(),
  kernel:kernel,
});

Map.addLayer(fmajority_2022, {min: 0, max: 2, palette: ['green', 'orange', 'blue']}, 'fmajority_2022');
Map.centerObject(roi, 10)

//Export monitoring
  Export.image.toDrive({
  image: fmajority_2022, 
  scale: 5, 
  description: 'Class_2022', //Rename the file
  maxPixels: 1e12,
  folder: 'Class', //Rename the folder
  region: roi,
  skipEmptyTiles: true,
  formatOptions: {
    cloudOptimized: true,
  }
});

// Export an ee.FeatureCollection as an Earth Engine asset.
Export.table.toDrive({
  collection: gcp,
  folder: 'Class',
  description:'samples_exp', //Rename the file
});


//Export image 2022
var Exp_comp_2022 = comp_2022.select("B2", "B3", "B4", "B8", "ndvi", "bsi")

  Export.image.toDrive({
  image: Exp_comp_2022, 
  scale: 5, 
  description: 'IMG_2022', //Rename the file
  maxPixels: 1e12,
  folder: 'Class', //Rename the folder
  region: roi,
  skipEmptyTiles: true,
  formatOptions: {
    cloudOptimized: true,
  }
});

// Accuracy Assessment
// Use classification map to assess accuracy using the validation fraction
// of the overall training set created above.
var test_2022 = classified_2022.sampleRegions({
  collection: validationGcp,
  properties: ['landcover'],
  tileScale: 16,
  scale: 10,
});


var testConfusionMatrix_2022 = test_2022.errorMatrix('landcover', 'classification')
// Printing of confusion matrix may time out. Alternatively, you can export it as CSV
print('Confusion Matrix 2022', testConfusionMatrix_2022);
print('Test Accuracy 2022', testConfusionMatrix_2022.accuracy());

