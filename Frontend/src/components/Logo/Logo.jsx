import './Logo.css';
import React from "react";

export const Logo = ({ className = "" }) => {
  return (
    <span className={`logo-root ${className}`}>
      {/* Geometric shield mark */}
      <img src="/logo.png" alt="RBrick Logo" className="logo-mark" />
      {/* Wordmark */}
      <span className="logo-wordmark">RBrick</span>
    </span>
  );
};
