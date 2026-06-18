import os
import time
import sqlite3
import json
from playwright.sync_api import sync_playwright

def run():
    print("Launching browser...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        
        # Navigate and login
        page.goto("http://localhost:4321/login")
        page.wait_for_load_state("networkidle")
        
        page.locator("label:has-text('Usuario') + input").fill("admin")
        page.locator("label:has-text('Contraseña') + input").fill("password123")
        page.locator("button[type='submit']").click()
        page.wait_for_timeout(3000)
        
        # Get token
        token = page.evaluate("localStorage.getItem('nt_token')")
        print(f"JWT Token: {token[:20]}...")
        
        # Fetch /api/providers using page.evaluate to run in browser context
        providers_data = page.evaluate("""async (token) => {
            const res = await fetch('/api/providers', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            return res.json();
        }""", token)
        
        print("Response from /api/providers:")
        print(json.dumps(providers_data, indent=2))
        
        # Fetch /api/config
        config_data = page.evaluate("""async (token) => {
            const res = await fetch('/api/config', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            return res.json();
        }""", token)
        
        print("Response from /api/config:")
        print(json.dumps(config_data, indent=2))
        
        browser.close()

if __name__ == "__main__":
    run()
