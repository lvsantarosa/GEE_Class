

// ******************************************************************************************
//  * Institution:  Sao Paulo State University 
//  * Author:       Lucas Vituri Santarosa
//  * Email:        lucas.santarosa@unesp.br
//  ******************************************************************************************

//Initial settings
//1. Upload .zip compressed shp files and set with roi
//2. Select the drawing tool and select non-forest and forest swatches
//3. Edit the Geometries
//a) Rename the geometries (samples),
//b) Select import as "FeatureCollection",
//c) In Property write "landcover" and in Value "1" for forest and "0" non-forest pair
//4. Rename files and folder to export


/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

//Cloud Mask
//https://courses.spatialthoughts.com/end-to-end-gee.html#basic-supervised-classification
function maskS2sr(image) {
  var cloudBitMask = ee.Number(2).pow(10).int();  // Bits 10 - clouds 
  var cirrusBitMask = ee.Number(2).pow(11).int(); // Bits 11 - cirrus
  var qa = image.select('QA60'); // Get the pixel QA band.
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0) // All flags should be set to zero, indicating clear conditions
      .and(qa.bitwiseAnd(cirrusBitMask).eq(0));
  return image.updateMask(mask)
      .copyProperties(image, ["system:time_start"]);
}

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
    scale: 20,
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

////////////////////////////////////////////////////////////////////////////////////////////////////////////////

//Prepare the S2 images 
var s2 = ee.ImageCollection("COPERNICUS/S2_SR")
var rgbVis = {
  gamma: 1.2,
  min: 0,
  max: 5000,
  bands: ['B4', 'B3', 'B2'],
};

var img2022 = s2
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
  .filter(ee.Filter.date('2022-08-01', '2022-10-31')) //Select the range of date
  .filter(ee.Filter.bounds(roi))
  .map(maskS2sr)
  
  
print(img2022)

var comp_2022 = img2022.median().clip(roi).select('B2', 'B3', 'B4', 'B8', 'B11'); 
//var comp_2022 = normalize(comp_2022); //This operation can be slow if you use this correction in necessary change the rgbVis to min = 0 and max = 1
var comp_2022 = addIndices(comp_2022); 

///////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Get the Sentinel1 VV collection.
var collection = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'))
    .select(['VV']);

// Create a 3 band stack by selecting from different periods (months)
var im1 = ee.Image(collection.filterDate('2022-01-01', '2022-01-31').mean());
var im2 = ee.Image(collection.filterDate('2022-06-01', '2022-06-30').mean());
var im3 = ee.Image(collection.filterDate('2022-12-01', '2022-12-31').mean());
print(im3)

var stackVV = im1.addBands(im2).addBands(im3)
var composite = stackVV.clip(roi); 

var clip = ee.Image(composite).clip(roi);

////////////////////////////////////////////////////////////////////////////////////////////////////////////////

//Stack multspectral with SAR
comp_2022 = comp_2022.addBands(clip)
print(comp_2022)

// Display the input composite.
Map.addLayer(comp_2022, rgbVis, 'S2');
Map.addLayer(clip, {min: -25, max: 0}, 'S1');
Map.centerObject(roi, 10);

//Display indices
var ndvi = comp_2022.select("ndvi")
var bsi = comp_2022.select("bsi")

Map.addLayer(ndvi, {palette: ['white','red','orange','yellow','green'],min: -0.4, max: 1}, 'ndvi');
Map.addLayer(bsi, {palette: ['red','white','blue'],min: -0.4, max: 1}, 'bsi');


////////////////////////////////////////////////////////////////////////////////////////////////////////////////

//Classification process

// Merge the samples
var gcp = forest.merge(no_forest).merge(forest) //the first clase is 0

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

Map.addLayer(fmajority_2022, {min: 0, max: 2, palette: ['yellow', 'green']}, 'fmajority_2022');
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
