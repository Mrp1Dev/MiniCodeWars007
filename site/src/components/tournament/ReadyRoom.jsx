import React from "react";

export default function ReadyRoom({ totalParticipants = 0 }) {
  return (
    <div className="ready-room">
      <div className="ready-scanner">
        <div className="ready-scanner-ring" />
        <div className="ready-scanner-ring" style={{ animationDuration: "8s", width: "160px", height: "160px", margin: "30px" }} />
        <img src="/logo.png" alt="WnCC" style={{ height: "48px", opacity: 0.85, filter: "drop-shadow(0 0 12px rgba(201,169,97,0.5))" }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
        <h1 className="ready-title">AGENT ASSEMBLY</h1>
        <div className="ready-counter">
          {totalParticipants} AGENTS READY IN THE ARENA
        </div>
        <p className="faint" style={{ maxWidth: "480px", margin: "10px 0 0", fontSize: "14px" }}>
          All submissions locked. The Swiss Stage begins shortly. 6 Swiss rounds · Best of 5 matches · Top 32 cut.
        </p>
      </div>
    </div>
  );
}
