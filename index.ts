import * as types from '@vue-storefront/core/modules/cart/store/mutation-types'
import { Logger } from '@vue-storefront/core/lib/logger'
import isString from 'lodash-es/isString'
import rootStore from '@vue-storefront/core/store'

export const cartExtend = {
  key: 'cart',
  store: {
    modules: [
      {
        key: 'cart',
        module: {
          actions: {
            servercartAfterTotals (context, event) {
              if (event.resultCode === 200) {
                const totalsObj = event.result.totals ? event.result.totals : event.result
                Logger.info('Overriding server totals. ', 'cart', totalsObj)()
                let itemsAfterTotal = {}
                let platformTotalSegments = totalsObj.total_segments
                for (let item of totalsObj.items) {
                  if (item.options && isString(item.options)) item.options = JSON.parse(item.options)
                  itemsAfterTotal[item.item_id] = item
                  rootStore.dispatch('cart/updateItem', { product: { server_item_id: item.item_id, totals: item, qty: item.qty } }, { root: true }) // update the server_id reference
                }
                for (let segment of totalsObj.total_segments) {
                  if (segment.code == 'shipping') {
                    segment.value = totalsObj.shipping_incl_tax
                  }
                }
                rootStore.commit(types.SN_CART + '/' + types.CART_UPD_TOTALS, { itemsAfterTotal: itemsAfterTotal, totals: totalsObj, platformTotalSegments: platformTotalSegments })
              } else {
                Logger.error(event.result, 'cart')()
              }
            }
          }
        }
      }
    ]
  }
}
