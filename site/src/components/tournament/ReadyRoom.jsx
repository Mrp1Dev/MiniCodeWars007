import React from "react";

export default function ReadyRoom({ totalParticipants = 0, swissRounds = 8 }) {
  return (
    <section className="ready-room">
      <div className="ready-scanner" aria-hidden="true">
        <div className="ready-scanner-ring" />
        <div className="ready-scanner-ring inner" />
        <img src="/logo.png" alt="" className="ready-logo" />
      </div>

      <span className="bs-eyebrow">Submissions locked</span>
      <h1 className="ready-title">Agent Assembly</h1>
      <div className="ready-count">
        <b>{totalParticipants}</b>
        <span>agents in the arena</span>
      </div>

      <ol className="ready-steps">
        <li><b>{swissRounds}</b> Swiss rounds<small>everyone plays every round</small></li>
        <li><b>32</b> make the cut<small>seeded into a knockout bracket</small></li>
        <li><b>1</b> champion<small>names revealed from the quarter-finals</small></li>
      </ol>
    </section>
  );
}
