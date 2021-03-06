#!/usr/bin/env node
var fs = require( 'fs' );
var path = require( 'path' );
var process = require( "process" );
var glob = require('glob');
var promiseExec = require('child-process-promise').exec;
var execSync = require('child_process').execSync;
var Promise = require("bluebird");
var checkDependencies = require('./lib/check-dependencies');
var program = require('commander');

var OUTPUT_DIR = "out";

var BYTE_SIZE_TO_DIMENSIONS = { // A map of file size to the size value base to Convert's "size" parameter
  "36000000": "3000x2000",     // "Base 16"
  "36000016": "3000x2000+16",  // "Base 16" exported with header
  "20250000": "2250x1500",     // "Base 8"
  "20250016": "2250x1500+16",  // "Base 8" exported with header
  "9000000" : "1500x1000",      // "Base 4"
  "9000016" : "1500x1000+16"   // "Base 4" exported with header
};

program
  .version('0.0.10')
  .option('--output-dir [dir]', `Override the default the output sub-directory of "${OUTPUT_DIR}"`, OUTPUT_DIR)
  .option('--no-negfix', 'Skip running negfix8, leaving you with raw .tiff files for further processing with another tool')
  .option('--no-dependency-check', 'Avoid checking for dependencies')
  .option('--dimensions [width]x[height]', 'Manually specify pixel dimensions of raw file (useful for xpan, etc) format like "3000x2000"')
  .option('--e6', 'Skip running negfix8, apply ImageMagick\'s -auto-level on files.  Useful when scanning "Film Color: Positive" in TLXClientDemo')
  .option('--bw', 'Skip running negfix8, instead do the following via ImageMagick: invert, auto-level, and save in grey-scale colorspace')
  .option('--bw-rgb', 'Skip running negfix8, instead do the following via ImageMagick: invert, auto-level, and save in RGB colorspace')
  .parse(process.argv);

checkForDependencies().then(function(){
  if (!fs.existsSync(program.outputDir)){
    fs.mkdirSync(program.outputDir);
  }

  var rawFiles = scanDirectoryForFiles();
  var usableRawFilesWithSizeData = checkRawFileSizes(rawFiles);
  convertRawFilesToTiff(usableRawFilesWithSizeData).then(function(tifs){
    process.stdout.write("\n");

    if (program.negfix === false || program.e6 || program.bw || program.bwRgb) {
      var verb;
      if (program.e6) {
        varb = "auto-leveled";
      } else if (program.bw) {
        verb = "inverted and auto-leveled greyscale";
      } else if (program.bwRgb) {
        verb = "inverted and auto-leveled RGB";
      } else {
        verb = "raw";
      }
      console.log(`Done. ${tifs.length} ${tifs.length === 1 ? "file" : "files"} saved to the '${program.outputDir}' subdirectory as a ${verb} TIFF.`);
    } else {
      console.log("Converted raw files to tifs, inverting and balancing with negfix8...");
      var convertedFiles = adjustTifsWithNegfix8(tifs);
      process.stdout.write("\n");
      console.log(`Done. ${convertedFiles.length} ${convertedFiles.length === 1 ? "file" : "files"} saved to the '${program.outputDir}' subdirectory as processed TIFF.`);
    }
  });
});

function scanDirectoryForFiles () {
  var rawFiles = glob.sync('*.raw', {});

  if (!rawFiles.length) {
    exitWithError("No .raw files found in the current directory \nPlease run this script from the same directory where you have saved your planar .raw files from TLXClientDemo");
  } else {
    console.log(`Found ${rawFiles.length} raw files in current directory...`);
    return rawFiles;
  }
}

function checkRawFileSizes(rawFiles){
  var currentDir = process.cwd();
  var data = {};
  var badFiles = [];
  rawFiles.forEach(function(rawFile){
    var filePath = currentDir + "/" + rawFile;
    var sizeInBytes = fs.statSync(filePath).size;
    var dimensionsForConvert;
    if (program.dimensions && program.dimensions.split("x").length === 2) {
      // Manually specified image dimensions, but lets confirm
      var splitDimensions = program.dimensions.split("x"),
          width = parseInt(splitDimensions[0], 10),
          height = parseInt(splitDimensions[1], 10);

      if (sizeInBytes / (width * height) === 6) {
        dimensionsForConvert = `${width}x${height}`;
      } else if ((sizeInBytes - 16) / (width * height) === 6) {
        dimensionsForConvert = `${width}x${height}+16`;
      }

    } else {
      dimensionsForConvert = BYTE_SIZE_TO_DIMENSIONS[sizeInBytes.toString()];
    }

    if (!dimensionsForConvert) {
      badFiles.push(rawFile);
      console.error(`${rawFile} is the wrong size - please export via TLXClientDemo in "Planar" mode at "Original height and width" (or specify dimensions via --dimensions option)`);
    } else {
      data[rawFile] = {
        size: dimensionsForConvert
      };
    }
  });

  var validFileCount = Object.keys(data).length;
  if (validFileCount === 0) {
    exitWithError("Sorry, no .raw files in the current directory are the correct size.");
  } else if (validFileCount === rawFiles.length) {
    console.log(`All ${validFileCount} files in the current directory are a correct size...`);
  } else {
    console.log(`${validFileCount} files will be converted but ${rawFiles.length-validFileCount} (${badFiles.join(",")}) ${badFiles.length === 1 ? "is" : "are"} the wrong size...`);
  }

  return data;
}

function convertRawFilesToTiff (data) {
  process.stdout.write("CONVERTING: ");
  var conversionPromises = [];

  for (var item in data) {
     var promise = convertRawToTif(item, data[item].size);
     conversionPromises.push(promise);
     promise.then(function() {
       process.stdout.write(" ▢ ");
     }).catch(function(error) {
       exitWithError("Error converting a file from a raw to a tiff", item);
     });
  }
  return Promise.all(conversionPromises);
}

function convertRawToTif (name, sizeParameter) {
  var baseName = path.basename(name, ".raw");
  var destinationFile = `${baseName}.tif`;
  var noNegfix = program.negfix === false || program.e6 || program.bw || program.bwRgb;
  var extra = "";

  if (noNegfix) {
    destinationFile = path.join(program.outputDir, destinationFile);
  }

  if (program.e6) {
    extra = extra + " -auto-level";
  } else if (program.bw) {
    extra = extra + " -negate -auto-level -colorspace Gray";
  } else if (program.bwRgb) {
    extra = extra + " -negate -auto-level";
  }

  var cmd = `convert -size ${sizeParameter} -depth 16 -interlace plane rgb:"${name}" -gamma 2.2 ${extra} -interlace none tif:"${destinationFile}"`;

  if (process.platform === "win32") {
    cmd = "magick " + cmd;
  }

  return promiseExec(cmd).then(function(){
    return `${destinationFile}`;
  });
}

function adjustTifsWithNegfix8(tifs) {
  process.stdout.write("ADJUSTING: ");
  var result = []
  tifs.forEach(function(tif){
    process.stdout.write(" ▢ ");
    var cmd = `negfix8 -cs "${tif}" "${program.outputDir}/${tif}"`;
    var executedCommand = execSync(cmd);
    if (executedCommand.stderr) {
      console.log(`Error converting ${tif} to ${program.outputDir}/${tif}`);
    } else {
      result.push(tif);
    }
  });
  return result;
}

function checkForDependencies() {
  if (program.dependencyCheck === false) {
    console.log("Skipping Dependancy Check...")
    return Promise.resolve()
  }

  var promises = [];

  if (process.platform === "win32") {
    promises.push(checkDependencies("magick").then(function(success, error){
      if (!success) {
        exitWithError("'magick' from ImageMagick doesn't seem to exist, please install it");
      }
    }));
  } else {
    promises.push(checkDependencies("convert").then(function(success, error){
      if (!success) {
        exitWithError("'convert' from ImageMagick doesn't seem to exist, please install it");
      }
    }));
  }

  promises.push(checkDependencies("negfix8").then(function(success, error){
    if (!success) {
      exitWithError("'negfix8'doesn't seem to exist, please install it");
    }
  }));

  return Promise.all(promises);
}

function exitWithError (message) {
  console.error("ERROR: "+ message);
  process.exit(1);
}
