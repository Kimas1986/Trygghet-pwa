import { ImageResponse } from "next/og";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 64,
          background: "#111827",
          color: "white",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ fontWeight: 700 }}>Trygghet</div>

        <div
          style={{
            fontSize: 32,
            marginTop: 20,
            opacity: 0.85,
          }}
        >
          Status og varsler for hus du følger
        </div>
      </div>
    ),
    size
  );
}