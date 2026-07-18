import "./styles.css";
import "./styles/theme.css";
import React from 'react'
import ReactDOM from 'react-dom/client'
import BCCApp from '../BCCApp.jsx'
import AuthGuard from './components/AuthGuard.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGuard>
      <BCCApp />
    </AuthGuard>
  </React.StrictMode>,
)
