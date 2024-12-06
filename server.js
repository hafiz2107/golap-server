const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const dotenv = require("dotenv");
dotenv.config();
const fs = require("fs");
const { Readable } = require("stream");
const axios = require("axios");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);

const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_KEY,
});

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION,
});

const io = new Server(server, {
  cors: {
    origin: process.env.ELECTRON_HOST,
    methods: ["GET", "POST"],
  },
});

let recordedChunks = [];

io.on("connection", (socket) => {
  console.log("🟩 Socket is connected");

  socket.on("video-chunks", async (data) => {
    console.log("🟩 Video chunk received");
    const writeStream = fs.createWriteStream("temp_upload/" + data.filename);
    recordedChunks.push(data.chunks);
    const videoBlob = new Blob(recordedChunks, {
      type: "video/webm; codecs=vp9",
    });

    const buffer = Buffer.from(await videoBlob.arrayBuffer());
    const readStream = Readable.from(buffer);
    readStream.pipe(writeStream).on("finish", () => {
      console.log("🍃 Chunk saved");
    });
  });
  socket.on("process-video", async (data) => {
    console.log("🟩 Processing video....");
    recordedChunks = [];

    fs.readFile("temp_upload" + data.filename, async (err, file) => {
      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`
      );

      if (processing.data.status !== 200) {
        console.log("🎈 Error somethign went wrong");
        const Key = data.filename;
        const Bucket = process.env.BUCKET_NAME;
        const ContentType = "video/webm";
        const command = new PutObjectCommand({
          Key,
          Bucket,
          ContentType,
          Body: file,
        });

        const fileStatus = await s3.send(command);

        if (fileStatus["$metadata"].httpStatusCode === 200) {
          console.log("🟩 Video uploaded to s3");

          if (processing.data.plan === "PRO") {
            fs.stat("temp_upload/" + data.filename, async (err, stat) => {
              if (!err) {
                // Wisper AI restriction 25 MB
                if (stat.size < 25000000) {
                  const transcription =
                    await openai.audio.transcriptions.create({
                      file: fs.createReadStream("temp_upload/" + data.filename),
                      model: "whisper-1",
                      response_format: "text",
                    });

                  if (transcription) {
                    const completion = await openai.chat.completions.create({
                      model: "gpt-3.5-turbo",
                      response_format: { type: "json_object" },
                      messages: [
                        {
                          role: "system",
                          content: `You are going to generate a title and nice description using the speech to text transcription provided :transcription (${transcription}) and then return it is json format as {"title": <the title you gave>,"summery":<the summary you create>}`,
                        },
                      ],
                    });

                    const titleAndSummeryGenerated = await axios.post(
                      `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                      {
                        filename: data.filename,
                        content: completion.choices[0].message.content,
                        transcript: transcription,
                      }
                    );

                    if (titleAndSummeryGenerated.data.status !== 200)
                      console.log(
                        "something went wrong when creating the title and description"
                      );
                  }
                }
              }
            });
          }
        }
        const stopProcessing = await axios.post(
          `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
          {
            filename: data.filename,
          }
        );

        if (titleAndSummeryGenerated.data.status !== 200)
          console.log("something went wrong when stopping the processing");

        if (stopProcessing.data.status === 200) {
          fs.unlink("temp_upload/" + data.filename, (err) => {
            if (!err) console.log(data.filename + " " + "Deleted successfully");
          });
        }
      } else {
        console.log("Error upload failed, Process aborted");
      }
    });
  });
  socket.on("disconnect", async (data) => {
    console.log("🟩 Disconnecting socket", socket.id);
  });
});

app.use(cors());
server.listen(5001, () => console.log("🟩 Listening to port 5001"));
