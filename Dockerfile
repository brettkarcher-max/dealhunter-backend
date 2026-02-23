# Use Microsoft's official Playwright image — it has Chrome pre-installed
FROM mcr.microsoft.com/playwright:v1.42.1-jammy

WORKDIR /app

# Copy package files first (better Docker layer caching)
COPY package*.json ./

# Install Node dependencies
RUN npm install

# Copy the rest of the app
COPY . .

# Expose the port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]
