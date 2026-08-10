import { describe, expect, it } from 'vitest'

import { selectComplementaryProfileUrls } from './routes.js'

describe('selectComplementaryProfileUrls', () => {
    it('keeps one Yelp listing and one social profile for complementary research', () => {
        expect(selectComplementaryProfileUrls([
            'https://facebook.com/example-contractor',
            'https://www.yelp.com/biz/example-contractor-clarksville',
            'https://instagram.com/example-contractor',
        ])).toEqual([
            'https://www.yelp.com/biz/example-contractor-clarksville',
            'https://facebook.com/example-contractor',
        ])
    })

    it('rejects Yelp search pages and unrelated URLs', () => {
        expect(selectComplementaryProfileUrls([
            'https://www.yelp.com/search?find_desc=contractors',
            'https://example.com',
        ])).toEqual([])
    })
})