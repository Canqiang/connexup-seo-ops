import { Link } from 'react-router-dom'

type MerchantSection = 'operations' | 'performance' | 'profile'

export default function MerchantSectionNav({ merchantId, active }: { merchantId: number; active: MerchantSection }) {
  return (
    <nav className="merchant-section-nav" aria-label="商户视图">
      <Link to={`/merchants/${merchantId}`} aria-current={active === 'operations' ? 'page' : undefined}>运营</Link>
      <Link to={`/merchants/${merchantId}/performance`} aria-current={active === 'performance' ? 'page' : undefined}>表现</Link>
      <Link to={`/merchants/${merchantId}/profile`} aria-current={active === 'profile' ? 'page' : undefined}>商户资料</Link>
    </nav>
  )
}
