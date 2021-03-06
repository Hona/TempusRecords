﻿const youtube_api = require("youtube-api"),
  ffmpeg = require("fluent-ffmpeg"),
  fs = require("fs"),
  Lien = require("lien"),
  prettyBytes = require("pretty-bytes"),
  config = require("./data/config.json"),
  oauthConfig = require("./data/oauth.json"),
  opn = require("opn"),
  utils = require("./utils.js"),
  fullbright = require("./data/fullbright_maps.json"),
  uploaded = require("./data/uploaded.json"),
  readline = require("readline"),
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

let hasTokens = false;
let initialized = false;

// TODO: this file is just full of shit

function init() {
  if (initialized) return;
  initialized = true;

  let server = new Lien({
    host: "localhost",
    port: "5000",
  });

  let oauth = youtube_api.authenticate(oauthConfig);

  opn(
    oauth.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/youtube"],
    })
  );

  server.addPage("/oauth2callback", (lien) => {
    console.log("Trying to get the token using the following code: " + lien.query.code);
    oauth.getToken(lien.query.code, (err, tokens) => {
      if (err) {
        lien.end(err, 400);
        return console.log(err);
      }

      console.log("Got the tokens.");

      oauth.setCredentials(tokens);

      lien.end("Uploads authorized.");

      hasTokens = true;
    });
  });
}

function getDuration(file) {
  return new Promise((resolve, reject) => {
    ffmpeg(file).ffprobe((err, data) => {
      if (err) {
        reject(err);
        return;
      }
      if (!data) {
        reject("no data");
        return;
      }
      resolve(data.format.duration);
    });
  });
}

async function compress(video, audio, run, cb) {
  if (!cb || typeof cb !== "function") throw "callback is not a function";

  const output = video.split(".mp4")[0] + "_compressed.mp4";
  let prevProgress = 0;

  let wrSplits = [];
  if (!isCollection) {
    wrSplits = run.splits;
  }

  let duration = 0;
  let audioDuration = 0;
  try {
    duration = await getDuration(video);
    audioDuration = await getDuration(audio);
  } catch (err) {
    console.log(`Failed to get the duration of ${video}`);
    console.log(err);
    return;
  }

  let videoFilters = [
    // Add a slight vignette
    {
      filter: "vignette",
      options: { angle: 0.1 },
    },
  ];

  // Use different color curve for fullbright maps
  let curveFile = "data/color_curves.acv";
  if (fullbright.includes(run.map.name)) {
    curveFile = "data/color_curves_fullbright.acv";
  }

  // Apply photoshop color curve.
  // Insert before vignette just in case that makes a difference.
  videoFilters.unshift({
    filter: "curves",
    options: { psfile: curveFile },
  });

  let audioFilters = [];

  // Get timestamps for text fading
  let fadeInStart =
    duration -
    config.video.text.endPadding -
    config.video.text.fadeOutDuration -
    config.video.text.displayDuration -
    config.video.text.fadeInDuration;

  // Modify alpha to fade text in and out
  let alphaTimeSplit = utils.getAlphaFade(
    fadeInStart,
    config.video.text.displayDuration,
    config.video.text.fadeInDuration,
    config.video.text.fadeOutDuration,
    config.video.text.maxAlpha
  );

  for (const split of wrSplits) {
    if (split.duration) {
      let alpha = utils.getAlphaFade(
        config.video.startPadding + split.duration - config.video.text.fadeInDuration,
        config.video.text.displayDuration,
        config.video.text.fadeInDuration,
        config.video.text.fadeOutDuration,
        config.video.text.maxAlpha
      );
      let zone = "";
      switch (split.type) {
        case "checkpoint":
          zone = `CP${split.zoneindex}`;
          break;

        case "course":
          zone = `Course ${split.zoneindex}`;
          break;

        case "map":
          zone = "Map";
          break;

        default:
          throw `Unhandled zone type ${split.type}`;
      }

      let text = `${zone}: ${utils.secondsToTimeStamp(split.duration)}`;
      text = utils.sanitize(text, true);

      videoFilters.push({
        filter: "drawtext",
        options: {
          ...config.video.text.ffmpegOptions,
          ...config.video.text.position.topLeft,
          text: text,
          alpha: alpha,
        },
      });

      if (split.comparedDuration) {
        text = `(${utils.secondsToTimeStamp(split.duration - split.comparedDuration, true)})`;
        text = utils.sanitize(text, true);

        videoFilters.push({
          filter: "drawtext",
          options: {
            ...config.video.text.ffmpegOptions,
            ...config.video.text.position.bottomLeft,
            text: text,
            alpha: alpha,
          },
        });
      }
    }
  }

  if (isCollection) {
    // Add map name, zone, and player name to video
    let displayDuration =
      duration - config.video.text.startPadding - config.video.text.fadeInDuration - config.video.text.fadeOutDuration;
    let alphaName = utils.getAlphaFade(
      config.video.text.startPadding,
      displayDuration,
      config.video.text.fadeInDuration,
      config.video.text.fadeOutDuration,
      config.video.text.maxAlpha
    );

    // Player
    videoFilters.push({
      filter: "drawtext",
      options: {
        ...config.video.text.ffmpegOptions,
        ...config.video.text.position.topLeft,
        text: utils.sanitize(run.player.name),
        alpha: alphaName,
      },
    });

    // Map
    videoFilters.push({
      filter: "drawtext",
      options: {
        ...config.video.text.ffmpegOptions,
        ...config.video.text.position.bottomLeft,
        text: utils.sanitize(run.map.name),
        alpha: alphaName,
      },
    });

    if (run.zone.customName) {
      // Custom name in bottom right
      videoFilters.push({
        filter: "drawtext",
        options: {
          ...config.video.text.ffmpegOptions,
          ...config.video.text.position.bottomRight,
          text: utils.sanitize(run.zone.customName),
          alpha: alphaName,
        },
      });

      // Move zone above name
      videoFilters.push({
        filter: "drawtext",
        options: {
          ...config.video.text.ffmpegOptions,
          ...config.video.text.position.topRight,
          text: utils.sanitize(run.zone.type + " " + run.zone.zoneindex),
          alpha: alphaName,
        },
      });
    } else {
      // Zone in bottom right
      videoFilters.push({
        filter: "drawtext",
        options: {
          ...config.video.text.ffmpegOptions,
          ...config.video.text.position.bottomRight,
          text: utils.sanitize(run.zone.type + " " + run.zone.zoneindex),
          alpha: alphaName,
        },
      });
    }
  }

  // Add video fade in/out
  videoFilters.push(
    {
      filter: "fade",
      options: `in:st=0:d=${config.video.fadeInDuration}`,
    },
    {
      filter: "fade",
      options: `out:st=${duration - config.video.fadeOutDuration}:d=${config.video.fadeOutDuration}`,
    }
  );

  // Add audio fade in/out
  // + stretching to match video length
  console.log(`audio/video ratio: ${audioDuration / duration}`);
  audioFilters.push(
    {
      filter: "atempo",
      options: `${audioDuration / duration}`,
    },
    {
      filter: "afade",
      options: `in:st=0:d=${config.audio.fadeInDuration}`,
    },
    {
      filter: "afade",
      options: `out:st=${duration - config.audio.fadeOutDuration}:d=${config.audio.fadeOutDuration}`,
    }
  );

  ffmpeg()
    .input(video)
    .input(audio)
    .videoFilters(videoFilters)
    .audioFilters(audioFilters)
    .fps(run.quality.fps)
    .size(run.quality.outputRes)
    .outputOptions(config.video.ffmpegOptions)
    .on("start", () => {
      console.log(`Started compressing ${video}`);
    })
    .on("progress", (progress) => {
      // Progress has no percentage with the settings used,
      // make our own percentage with blackjack and hookers.
      let frameCount = duration * run.quality.fps;
      let percentage = (100 * progress.frames) / frameCount;

      if (percentage > prevProgress + 5) {
        let eta = utils.secondsToTimeStamp((frameCount - progress.frames) / progress.currentFps);
        console.log(`Progress: ${Math.round(percentage - (percentage % 5))}%, ETA: ${eta} (${video})`);
        prevProgress += 5;
      }
    })
    .on("end", () => {
      console.log(`Finished compressing ${video}`);

      // Remove old video and audio
      if (config.video.deleteUncompressed) {
        fs.unlink(video, (err) => {
          if (err) {
            console.log("Failed to unlink uncompressed video");
            console.log(err);
          }
        });

        fs.unlink(audio, (err) => {
          if (err) {
            console.log("Failed to unlink audio");
            console.log(err);
          }
        });
      }

      return cb(true, output);
    })
    .on("error", (err) => {
      console.log(`Failed to process ${video}`);
      console.log(err.message);
      return cb(false, null);
    })
    .save(output);
}

async function upload(file, run) {
  if (isCollection) {
    concatCollection(() => {
      uploadCollection();
    });
    return;
  }

  if (!hasTokens) {
    console.log("Awaiting tokens");
    setTimeout(() => {
      upload(file, run);
    }, 5000);
    return;
  }

  console.log(`Uploading ${file}`);

  var description = "";
  var stats = fs.statSync(file);
  var fileSize = stats.size;
  var bytes = 0;

  let wrSplit = null;
  for (const split of run.splits) {
    if (split.type === "map") {
      if (split.comparedDuration && split.duration) {
        wrSplit = utils.secondsToTimeStamp(split.duration - split.comparedDuration, true);
      }
      break;
    }
  }

  config.youtube.description.forEach((line) => {
    var d = new Date();
    var demo_date = new Date(run.demo.date * 1000);
    line = line
      .replace("$MAP_URL", "https://tempus.xyz/maps/" + run.map.name)
      .replace("$MAP", run.map.name)
      .replace("$NAME", run.player.name)
      .replace("$TIME", utils.secondsToTimeStamp(run.duration))
      .replace("$SPLIT", wrSplit ? `(${wrSplit})` : "")
      .replace("$CLASS", `${run.class === "SOLDIER" ? "Soldier" : "Demoman"}`)
      .replace("$DATETIME", d.toUTCString())
      .replace("$DATE", demo_date.toUTCString())
      .replace("$DEMO_URL", "https://tempus.xyz/demos/" + run.demo.id);

    description += line + "\n";
  });

  // Common tags for all videos
  var tags = ["Team Fortress 2", "TF2", "rocketjump", "speedrun", "tempus", "record"];

  // Video specific tags
  var mapParts = run.map.name.split("_");
  tags.push(...mapParts);
  if (mapParts.length > 1) tags.push(`${mapParts[0]}_${mapParts[1]}`);
  tags.push(run.class === "SOLDIER" ? ["soldier", "solly"] : ["demoman", "demo"]);

  // Commas in player name will break youtube tags
  var playerName = run.player.name;
  playerName = playerName.replace(",", "");
  tags.push(playerName);

  let previousProgress = 0;

  var req = youtube_api.videos.insert(
    {
      resource: {
        snippet: {
          title: config.youtube.title
            .replace("$NAME", run.player.name)
            .replace("$MAP", run.map.name)
            .replace("$TIME", utils.secondsToTimeStamp(run.duration)),
          description: description,
          tags: tags,
        },
        status: {
          privacyStatus: "private",
          publishAt: new Date(Date.now() + 1000 * 60 * config.youtube.publishDelay).toISOString(),
        },
      },
      // This is for the callback function
      part: "snippet,status",

      // Create the readable stream to upload the video
      media: {
        body: fs.createReadStream(file).on("data", (chunk) => {
          bytes += chunk.length;
          let percentage = (100 * bytes) / fileSize;
          if (percentage > previousProgress + 5) {
            console.log(`${file}: ${prettyBytes(bytes)} (${Math.round(percentage - (percentage % 5))}%) uploaded.`);
            previousProgress += 5;
          }
        }),
      },
    },
    (err, response) => {
      if (err) {
        console.log("Failed to upload video");
        console.log(err);
        return;
      } else {
        console.log("Done uploading");
      }
      // Add video to class playlist
      youtube_api.playlistItems.insert(
        {
          resource: {
            snippet: {
              playlistId:
                run.class === "SOLDIER" ? "PL_D9J2bYWXyLFs5OJcTugl_70HqzDN9nv" : "PL_D9J2bYWXyIeRkUq099oCV8wf5Omf9Fe",
              resourceId: {
                kind: "youtube#video",
                videoId: response.data.id,
              },
            },
          },
          part: "snippet",
        },
        (err, response) => {
          if (err) {
            console.log("Failed to add video to playlist");
            console.log(err);
          } else {
            console.log("Video added to playlist");
          }
        }
      );

      // Add to uploaded runs
      utils.readJson("./data/uploaded.json", (err, uploaded) => {
        if (err !== null) {
          console.log("Failed to read last uploaded");
          console.log(err);
          return;
        }

        if (!uploaded.maps.includes(run.id)) uploaded.maps.push(run.id);

        utils.writeJson("./data/uploaded.json", uploaded, (err) => {
          if (err !== null) {
            console.log("Failed to write last uploaded");
            console.log(err);
            return;
          }

          console.log("Updated uploaded list");
        });

        // Remove compressed video
        if (config.video.deleteCompressed) {
          fs.unlink(file, (err) => {
            if (err) {
              console.log("Failed to unlink uploaded video");
              console.log(err);
              return;
            }

            console.log("Unlinked uploaded video");
          });
        }
      });
    }
  );
}

async function concatCollection(cb) {
  if (typeof cb !== "function") {
    throw "callback is not a function";
  }

  console.log("Concatenating videos");

  for (let i = collectionRuns.length - 1; i >= 0; i--) {
    if (!fs.existsSync(collectionRuns[i].outputFile)) {
      collectionRuns.splice(i, 1);
    }
  }

  let duration = 0;

  for (let run of collectionRuns) {
    try {
      duration += await getDuration(run.outputFile);
    } catch (err) {
      console.log(err);
    }
  }

  let frameCount = duration * 60;
  let prevProgress = 0;
  let completed = false;
  let ff = ffmpeg();

  for (let i = 0; i < collectionRuns.length; i++) {
    ff.input(collectionRuns[i].outputFile);
  }

  ff.on("error", (err) => {
    console.log("Failed to concatenate files");
    console.error(err);
  })
    .on("progress", (progress) => {
      let percentage = (100 * progress.frames) / frameCount;

      if (percentage > prevProgress + 5) {
        let eta = utils.secondsToTimeStamp((frameCount - progress.frames) / progress.currentFps);
        console.log(`Concat progress: ${Math.round(percentage - (percentage % 5))}%, ETA: ${eta}`);
        prevProgress += 5;
      }
    })
    .on("end", () => {
      // This gets called multiple times for some reason
      if (completed) {
        return;
      }
      completed = true;

      console.log("Finished concatenating");
      cb();
    })
    .mergeToFile(config.svr.recordingFolder + "/collection.mp4", config.svr.recordingFolder);
}

async function uploadCollection() {
  if (!hasTokens) {
    console.log("Awaiting tokens");
    setTimeout(() => {
      uploadCollection();
    }, 5000);
    return;
  }

  const isBonus = collectionRuns[0].zone.type === "bonus";

  console.log(`Uploading collection`);

  var file = config.svr.recordingFolder + "/collection.mp4";
  var description = "";
  var stats = fs.statSync(file);
  var fileSize = stats.size;
  var bytes = 0;

  let date = new Date();

  let useTimestamps = true;
  let seconds = 0;
  description = "Runs:\n";
  for (let run of collectionRuns) {
    if (useTimestamps) {
      try {
        let duration = await getDuration(run.outputFile);
        let timeElapsed = new Date(0);
        timeElapsed.setSeconds(Math.floor(seconds));
        let timestamp = `${timeElapsed.getMinutes()}:${
          timeElapsed.getSeconds() < 10 ? "0" : ""
        }${timeElapsed.getSeconds()}`;
        description += `${timestamp} ${run.map.name} ${isBonus ? "Bonus" : "Trick"} ${run.zone.zoneindex}${
          run.zone.customName ? " (" + run.zone.customName + ")" : ""
        } by ${run.player.name} (${run.class === "SOLDIER" ? "Soldier" : "Demoman"})\n`;
        seconds += duration;
      } catch (err) {
        console.log(`Error getting duration of ${run.outputFile}!`);
        console.error(err);
        // Failing to get the length of 1 video will make all future timestamps inaccurate
        useTimestamps = false;
      }
    }

    if (!useTimestamps) {
      description += `${run.map.name} ${isBonus ? "Bonus" : "Trick"} ${run.zone.zoneindex} by ${run.player.name} (${
        run.class === "SOLDIER" ? "Soldier" : "Demoman"
      })\n`;
    }
  }
  description += "\n";

  config.youtube.collectionDescription.forEach((line) => {
    line = line.replace("$DATETIME", date.toUTCString());
    description += line + "\n";
  });

  // Common tags for all videos
  var tags = ["Team Fortress 2", "TF2", "rocketjump", "speedrun", "tempus", "record", "soldier", "demoman"];

  if (isBonus) {
    tags.push(...["bonus", "bonuses", "bonus collection"]);
  } else {
    tags.push(...["trick", "tricks", "trick collection"]);
  }

  let previousProgress = 0;

  var req = youtube_api.videos.insert(
    {
      resource: {
        snippet: {
          title: config.youtube.collectionTitle
            .replace("$ZONETYPE", isBonus ? "Bonus" : "Trick")
            .replace("$NUMBER", isBonus ? uploaded.bonusCollections + 1 : uploaded.trickCollections + 1),
          description: description,
          tags: tags,
        },
        status: {
          privacyStatus: "private",
          publishAt: new Date(Date.now() + 1000 * 60 * config.youtube.publishDelay).toISOString(), // Allow time for processing before making public
        },
      },
      // This is for the callback function
      part: "snippet,status",

      // Create the readable stream to upload the video
      media: {
        body: fs.createReadStream(file).on("data", (chunk) => {
          bytes += chunk.length;
          let percentage = (100 * bytes) / fileSize;
          if (percentage > previousProgress + 5) {
            console.log(`${file}: ${prettyBytes(bytes)} (${Math.round(percentage - (percentage % 5))}%) uploaded.`);
            previousProgress += 5;
          }
        }),
      },
    },
    (err, response) => {
      if (err) {
        console.log("Failed to upload video");
        console.log(err);
      } else {
        console.log("Done uploading");
      }

      // Youtube sucks
      rl.question("Was youtube processing succesful? Y/n", (answer) => {
        if (answer === "n") {
          // Reupload
          uploadCollection();
          return;
        }

        // Add video to playlist
        youtube_api.playlistItems.insert(
          {
            resource: {
              snippet: {
                playlistId: isBonus ? "PL_D9J2bYWXyJBc0YvjRpqpFc5hY-ieU-B" : "PL_D9J2bYWXyJYdkfuv8s0kTvQygJQkW8_",
                resourceId: {
                  kind: "youtube#video",
                  videoId: response.data.id,
                },
              },
            },
            part: "snippet",
          },
          (err, response) => {
            if (err) {
              console.log("Failed to add video to playlist");
              console.log(err);
            } else {
              console.log("Video added to playlist");
            }
          }
        );

        // Add to uploaded runs
        utils.readJson("./data/uploaded.json", (err, uploaded) => {
          if (err !== null) {
            console.log("Failed to read last uploaded");
            console.log(err);
            return;
          }

          let accessor = isBonus ? "bonuses" : "tricks";
          for (let run of collectionRuns) {
            if (!uploaded[accessor].includes(run.id)) {
              uploaded[accessor].push(run.id);
            }
          }

          accessor = isBonus ? "bonusCollections" : "trickCollections";
          uploaded[accessor] += 1;

          utils.writeJson("./data/uploaded.json", uploaded, (err) => {
            if (err !== null) {
              console.log("Failed to write last uploaded");
              console.log(err);
              return;
            }

            console.log("Updated uploaded list");
          });
        });
      });
    }
  );
}

module.exports.init = init;
module.exports.compress = compress;
module.exports.upload = upload;
