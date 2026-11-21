import { Modal } from './ui'

export function FieldGuide({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Coastal field guide" onClose={onClose}>
      <div className="guide">
        <h3>Mission</h3>
        <p>
          Deliver at least 80% of requested supplies by turn 12. Harbor Clinic and Hill Hospital
          carry the greatest weight in the priority score.
        </p>
        <h3>Work a turn</h3>
        <p>
          The commander starts the run and advances time. Dispatchers choose a truck, destination
          and cargo. The board reserves stock and open demand as soon as a shipment is accepted.
        </p>
        <h3>Read the roads</h3>
        <p>
          Routes follow the fastest open roads. Check the arrival turn before sending cargo. After
          delivering, a truck drives home on the fastest road open at that moment, so a closure can
          keep it away for longer.
        </p>
        <h3>Plan for disruptions</h3>
        <p>
          Every operation schedules three disruptions: a road closes, a depot is flooded and loses
          stock, and a relief site asks for more supplies. The alerts in the feed announce each one
          on its turn, and the turn and place differ by scenario, so watch the feed before you
          commit cargo. Today's scenario is the same for every crew, so scores are comparable.
          Classic is the original exercise, and any seed you type deals the same game every time.
        </p>
      </div>
    </Modal>
  )
}
