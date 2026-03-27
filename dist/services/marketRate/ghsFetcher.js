import axios from 'axios';
import { validatePrice } from './validation';
export class GHSRateFetcher {
    coinGeckoUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ghs,usd&include_last_updated_at=true';
    usdToGhsUrl = 'https://open.er-api.com/v6/latest/USD';
    getCurrency() {
        return 'GHS';
    }
    async fetchRate() {
        try {
            const coinGeckoResponse = await axios.get(this.coinGeckoUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'StellarFlow-Oracle/1.0'
                }
            });
            const stellarPrice = coinGeckoResponse.data.stellar;
            if (!stellarPrice) {
                throw new Error('CoinGecko did not return a Stellar price payload');
            }
            const lastUpdatedAt = stellarPrice.last_updated_at
                ? new Date(stellarPrice.last_updated_at * 1000)
                : new Date();
            if (typeof stellarPrice.ghs === 'number') {
                return {
                    currency: 'GHS',
                    rate: validatePrice(stellarPrice.ghs),
                    timestamp: lastUpdatedAt,
                    source: 'CoinGecko'
                };
            }
            if (typeof stellarPrice.usd !== 'number') {
                throw new Error('CoinGecko did not return a usable USD price for Stellar');
            }
            const usdPrice = validatePrice(stellarPrice.usd);
            const exchangeRateResponse = await axios.get(this.usdToGhsUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'StellarFlow-Oracle/1.0'
                }
            });
            const usdToGhsRate = exchangeRateResponse.data.rates?.GHS;
            if (exchangeRateResponse.data.result !== 'success' || typeof usdToGhsRate !== 'number') {
                throw new Error('USD to GHS conversion feed did not return a usable GHS rate');
            }
            const validatedUsdToGhsRate = validatePrice(usdToGhsRate);
            const fxTimestamp = exchangeRateResponse.data.time_last_update_unix
                ? new Date(exchangeRateResponse.data.time_last_update_unix * 1000)
                : lastUpdatedAt;
            return {
                currency: 'GHS',
                rate: validatePrice(usdPrice * validatedUsdToGhsRate),
                timestamp: fxTimestamp > lastUpdatedAt ? fxTimestamp : lastUpdatedAt,
                source: 'CoinGecko + ExchangeRate API'
            };
        }
        catch (error) {
            throw new Error(`Failed to fetch GHS rate: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    async isHealthy() {
        try {
            const rate = await this.fetchRate();
            return rate.rate > 0;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=ghsFetcher.js.map