import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import { prepareOfflineRestart } from '@/lib/offline-registration'
void prepareOfflineRestart()
import '@/index.css'
import '@/styles/odina-retail.css'
import '@/styles/odina-system.css'
import '@/styles/odina-workbench.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)